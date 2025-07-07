const { useMultiFileAuthState } = require("@whiskeysockets/baileys");
const fs = require("fs-extra");
const path = require("path");
const tar = require("tar");
const { connectDb } = require("./db");

const AUTH_DIR = "./auth_info";
const AUTH_TAR = "auth_info.tar";

async function useMongoAuthState() {
    const db = await connectDb();
    const coll = db.collection("auth");
    const session = await coll.findOne({ _id: "session" });

    // Clean up any previous data
    await fs.remove(AUTH_DIR);
    await fs.remove(AUTH_TAR);

    // Step 1: Restore session from MongoDB archive
    if (session && session.archive) {
        try {
            await fs.writeFile(AUTH_TAR, session.archive.buffer);
            await tar.x({ file: AUTH_TAR, C: "." });

            const credsPath = path.join(AUTH_DIR, "creds.json");
            const credsExists = await fs.pathExists(credsPath);

            if (!credsExists) {
                console.warn("⚠️ creds.json missing in archive. Session may be corrupted.");
                await coll.deleteOne({ _id: "session" });
                await fs.remove(AUTH_DIR);
            } else {
                console.log("✅ Session restored from DB.");
            }
        } catch (err) {
            console.error("❌ Failed to extract session:", err);
            await coll.deleteOne({ _id: "session" });
            await fs.remove(AUTH_DIR);
        }
    } else {
        console.log("ℹ️ No existing session found. QR code will be shown.");
    }

    // Step 2: Create auth state
    const { state, saveCreds: originalSaveCreds } = await useMultiFileAuthState(AUTH_DIR);

    // Step 3: Custom saveCreds with DB update
    async function saveCreds() {
        await originalSaveCreds();
        await tar.c({ file: AUTH_TAR, cwd: ".", portable: true }, ["auth_info"]);
        const data = await fs.readFile(AUTH_TAR);

        await coll.updateOne(
            { _id: "session" },
            { $set: { archive: data } },
            { upsert: true }
        );

        await fs.remove(AUTH_TAR);
    }

    return { state, saveCreds };
}

module.exports = { useMongoAuthState };

const { useMultiFileAuthState } = require("@whiskeysockets/baileys");
const fs = require("fs-extra");
const path = require("path");
const tar = require("tar");
const { connectDb } = require("./db");
const config = require("../config");

const AUTH_DIR = "./auth_info";
const AUTH_TAR = "auth_info.tar";

async function useMongoAuthState() {
    const useMongo = config.get("auth.mongo-session") === true;

    // Always create local auth state
    await fs.ensureDir(AUTH_DIR);
    const { state, saveCreds: originalSaveCreds } = await useMultiFileAuthState(AUTH_DIR);

    if (!useMongo) {
        console.log("⚙️ Mongo auth disabled in config. Using local session only.");
        return { state, saveCreds: originalSaveCreds };
    }

    console.log("🔗 Mongo auth enabled. Syncing with database...");
    const db = await connectDb();
    const coll = db.collection("auth");
    const session = await coll.findOne({ _id: "session" });

    // Step 1: Restore from DB
    await fs.remove(AUTH_TAR);
    if (session?.archive) {
        try {
            await fs.writeFile(AUTH_TAR, session.archive.buffer);
            await tar.x({ file: AUTH_TAR, C: "." });
            const credsExists = await fs.pathExists(path.join(AUTH_DIR, "creds.json"));
            if (!credsExists) throw new Error("creds.json missing");
            console.log("✅ Session restored from MongoDB.");
        } catch (err) {
            console.error("❌ Failed to restore session from DB:", err.message);
            await coll.deleteOne({ _id: "session" });
            await fs.remove(AUTH_DIR);
        }
    } else {
        console.log("ℹ️ No session found in DB. New QR code will be generated.");
    }

    // Step 2: Wrap saveCreds to also save to DB
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

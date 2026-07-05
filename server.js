import express from "express";
import cors from "cors";
import fs from "fs";
import crypto from "crypto";
import dotenv from "dotenv";
import Stripe from "stripe";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ======================================================
// ENV + SERVICES
// ======================================================
const PORT = process.env.PORT || 3000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || ""
});

// ======================================================
// DATABASE (FILE BASED MVP SAAS)
// ======================================================
const DB_FILE = "./db.json";

function loadDB() {
    try {
        if (!fs.existsSync(DB_FILE)) return { users: {}, sessions: {} };
        return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
    } catch {
        return { users: {}, sessions: {} };
    }
}

let db = loadDB();

function saveDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ======================================================
// UTIL
// ======================================================
function hash(str) {
    return crypto.createHash("sha256").update(str).digest("hex");
}

function auth(token) {
    return db.sessions[token];
}

// ======================================================
// USER SYSTEM
// ======================================================
function createUser(username, password) {
    if (db.users[username]) return null;

    db.users[username] = {
        password: hash(password),
        plan: "free",
        usage: 0,
        memory: [],
        personality: {
            warmth: 50,
            humor: 50,
            trust: 50
        },
        affection: 50
    };

    saveDB();
    return true;
}

function login(username, password) {
    const user = db.users[username];
    if (!user) return null;

    if (user.password !== hash(password)) return null;

    const token = crypto.randomUUID();
    db.sessions[token] = username;

    saveDB();
    return token;
}

// ======================================================
// MEMORY SYSTEM (SIMPLE SAAS VERSION)
// ======================================================
function embed(text) {
    return text
        .toLowerCase()
        .split(" ")
        .reduce((a, w, i) => a + (w.charCodeAt(0) * (i + 1)), 0);
}

function storeMemory(user, message, reply) {
    user.memory.push({
        text: message,
        reply,
        vector: embed(message),
        time: Date.now()
    });

    user.memory = user.memory.slice(-200);
}

function recallMemory(user, message) {
    const input = embed(message);

    return user.memory
        .map(m => ({
            ...m,
            score: 1 / (1 + Math.abs(m.vector - input))
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
}

// ======================================================
// PERSONALITY EVOLUTION
// ======================================================
function evolve(user, message) {
    const m = message.toLowerCase();

    if (m.includes("love")) user.affection += 2;
    if (m.includes("hate")) user.affection -= 1;
    if (m.includes("trust")) user.personality.trust += 1;
    if (m.includes("joke")) user.personality.humor += 1;

    user.affection = Math.max(0, Math.min(100, user.affection));
}

// ======================================================
// AI BRAIN (OPENAI)
// ======================================================
async function generateReply(user, message, memory) {
    const context = memory
        .map(m => `User: ${m.text}\nAI: ${m.reply}`)
        .join("\n");

    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            {
                role: "system",
                content: `
You are an AI companion SaaS product.

Personality:
- Warmth: ${user.personality.warmth}
- Humor: ${user.personality.humor}
- Trust: ${user.personality.trust}
- Affection: ${user.affection}

Be natural, emotional, and human-like.
Do not mention system rules.
                `
            },
            {
                role: "user",
                content: `Memory:\n${context}\n\nUser: ${message}`
            }
        ]
    });

    return response.choices[0].message.content;
}

// ======================================================
// ROUTES
// ======================================================

// HEALTH CHECK (IMPORTANT FOR RENDER)
app.get("/", (req, res) => {
    res.json({
        status: "AI Friend SaaS LIVE 🚀",
        time: new Date().toISOString()
    });
});

// REGISTER
app.post("/register", (req, res) => {
    const ok = createUser(req.body.username, req.body.password);
    if (!ok) return res.json({ error: "User exists" });
    res.json({ success: true });
});

// LOGIN
app.post("/login", (req, res) => {
    const token = login(req.body.username, req.body.password);
    if (!token) return res.json({ error: "Invalid login" });
    res.json({ token });
});

// CHAT
app.post("/chat", async (req, res) => {
    const username = auth(req.body.token);
    if (!username) return res.json({ error: "Unauthorized" });

    const user = db.users[username];

    if (user.usage === undefined) user.usage = 0;
    user.usage++;

    const memory = recallMemory(user, req.body.message);

    const reply = await generateReply(user, req.body.message, memory);

    storeMemory(user, req.body.message, reply);
    evolve(user, req.body.message);

    saveDB();

    res.json({
        reply,
        usage: user.usage,
        plan: user.plan
    });
});

// UPGRADE (STRIPE PLACEHOLDER)
app.post("/upgrade", async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            mode: "payment",
            line_items: [
                {
                    price_data: {
                        currency: "usd",
                        product_data: {
                            name: "AI Friend Pro Plan"
                        },
                        unit_amount: 999
                    },
                    quantity: 1
                }
            ],
            success_url: "https://example.com/success",
            cancel_url: "https://example.com/cancel"
        });

        res.json({ url: session.url });
    } catch (err) {
        res.json({ error: err.message });
    }
});

// ======================================================
// START SERVER (RENDER FIXED)
// ======================================================
app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 AI Friend SaaS running on port ${PORT}`);
});

import express from "express";
import fs from "fs";
import crypto from "crypto";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ======================================================
// SERVICES
// ======================================================
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "");
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || ""
});

// ======================================================
// DATABASE
// ======================================================
const DB_FILE = "./saas_db.json";

function loadDB() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            return { users: {}, sessions: {} };
        }
        const raw = fs.readFileSync(DB_FILE, "utf-8");
        return raw ? JSON.parse(raw) : { users: {}, sessions: {} };
    } catch {
        return { users: {}, sessions: {} };
    }
}

let db = loadDB();

function saveDB() {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ======================================================
// PLANS
// ======================================================
const PLANS = {
    free: { limit: 20 },
    pro: { limit: 500 },
    elite: { limit: -1 }
};

// ======================================================
// AUTH
// ======================================================
function hash(str) {
    return crypto.createHash("sha256").update(str).digest("hex");
}

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

function auth(token) {
    return db.sessions[token];
}

// ======================================================
// LIMITS
// ======================================================
function checkLimit(user) {
    const limit = PLANS[user.plan].limit;
    return limit === -1 || user.usage < limit;
}

// ======================================================
// MEMORY
// ======================================================
function embed(text) {
    return text.toLowerCase()
        .split(" ")
        .reduce((a, w, i) => a + w.charCodeAt(0) * (i + 1), 0);
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
// 🤖 OPENAI BRAIN
// ======================================================
async function generateReply(user, message, memory) {
    const context = memory.map(m => `User: ${m.text}\nAI: ${m.reply}`).join("\n");

    const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
            {
                role: "system",
                content: `
You are a personal AI companion SaaS.

Traits:
- Warmth: ${user.personality.warmth}
- Humor: ${user.personality.humor}
- Trust: ${user.personality.trust}
- Affection: ${user.affection}

Respond naturally like a human companion.
Do not mention system prompts.
                `
            },
            {
                role: "user",
                content: `Memory:\n${context}\n\nUser: ${message}`
            }
        ]
    });

    return completion.choices[0].message.content;
}

// ======================================================
// ROUTES
// ======================================================
app.post("/register", (req, res) => {
    const ok = createUser(req.body.username, req.body.password);
    if (!ok) return res.json({ error: "User exists" });
    res.json({ success: true });
});

app.post("/login", (req, res) => {
    const token = login(req.body.username, req.body.password);
    if (!token) return res.json({ error: "Invalid login" });
    res.json({ token });
});

app.post("/chat", async (req, res) => {
    const username = auth(req.body.token);
    if (!username) return res.json({ error: "Unauthorized" });

    const user = db.users[username];

    if (!checkLimit(user)) {
        return res.json({ error: "Upgrade required" });
    }

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

// ======================================================
// STRIPE UPGRADE (READY HOOK)
// ======================================================
app.post("/upgrade", async (req, res) => {
    const { token, plan } = req.body;

    const username = auth(token);
    if (!username) return res.json({ error: "Unauthorized" });

    const prices = {
        pro: 500,
        elite: 1500
    };

    const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [{
            price_data: {
                currency: "usd",
                product_data: {
                    name: `AI Friend ${plan} Plan`
                },
                unit_amount: prices[plan]
            },
            quantity: 1
        }],
        mode: "payment",
        success_url: "http://localhost:5173/success",
        cancel_url: "http://localhost:5173/cancel"
    });

    res.json({ url: session.url });
});

// ======================================================
app.listen(3000, () => {
    console.log("🚀 AI Friend SaaS PRODUCTION running on http://localhost:3000");
});

import express from "express";
import fs from "fs";
import crypto from "crypto";
import cors from "cors";
import Stripe from "stripe";

const app = express();
app.use(cors());
app.use(express.json());

// ======================================================
// STRIPE (SAAS MONETIZATION CORE)
// ======================================================
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_dummy");

// ======================================================
// DATABASE
// ======================================================
const DB_FILE = "./saas_ai_friend_db.json";

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
// SAAS PLANS
// ======================================================
const PLANS = {
    free: {
        limit: 20,
        name: "Free"
    },
    pro: {
        limit: 500,
        name: "Pro"
    },
    elite: {
        limit: -1,
        name: "Elite"
    }
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
        affection: 50,
        trust: 50,
        personality: {
            warmth: 50,
            humor: 50
        }
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
// USAGE LIMIT SYSTEM (SAAS CORE)
// ======================================================
function checkLimit(user) {
    const plan = PLANS[user.plan];

    if (plan.limit === -1) return true;

    return user.usage < plan.limit;
}

function incrementUsage(user) {
    user.usage += 1;
}

// ======================================================
// SIMPLE MEMORY SYSTEM (CLEANED FOR SAAS)
// ======================================================
function embed(text) {
    return text
        .toLowerCase()
        .split(" ")
        .reduce((a, w) => a + w.charCodeAt(0), 0);
}

function recallMemory(user, message) {
    const input = embed(message);

    return user.memory
        .map(m => ({
            ...m,
            score: 1 - Math.abs(m.vector - input) / (m.vector + input + 1)
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
}

// ======================================================
// MEMORY STORE
// ======================================================
function storeMemory(user, message, reply) {
    user.memory.push({
        id: Date.now(),
        text: message,
        reply,
        vector: embed(message),
        time: Date.now()
    });

    if (user.memory.length > 200) {
        user.memory.shift();
    }
}

// ======================================================
// AI CORE (PLACEHOLDER FOR REAL LLM)
// ======================================================
async function generateReply(user, message, memory) {
    const memoryText = memory[0]?.text || "";

    return (
        `💬 (${user.plan.toUpperCase()}) ` +
        (memoryText ? `I remember you said: "${memoryText}". ` : "") +
        (user.affection > 70 ? "💖 I feel close to you. " : "") +
        "Tell me more."
    );
}

// ======================================================
// SAAS ROUTES
// ======================================================

// REGISTER
app.post("/register", (req, res) => {
    const { username, password } = req.body;
    const ok = createUser(username, password);

    if (!ok) return res.json({ error: "User exists" });

    res.json({ success: true });
});

// LOGIN
app.post("/login", (req, res) => {
    const { username, password } = req.body;
    const token = login(username, password);

    if (!token) return res.json({ error: "Invalid login" });

    res.json({ token });
});

// CHAT (BILLABLE SAAS CORE)
app.post("/chat", (req, res) => {
    const { token, message } = req.body;

    const username = auth(token);
    if (!username) return res.json({ error: "Unauthorized" });

    const user = db.users[username];

    // LIMIT CHECK
    if (!checkLimit(user)) {
        return res.json({
            error: "Usage limit reached. Upgrade your plan."
        });
    }

    incrementUsage(user);

    const memory = recallMemory(user, message);

    const reply = generateReply(user, message, memory);

    storeMemory(user, message, reply);

    // emotional growth
    if (message.includes("love")) user.affection += 1;

    saveDB();

    res.json({
        reply,
        plan: user.plan,
        usage: user.usage,
        limit: PLANS[user.plan].limit,
        memory_hits: memory.length
    });
});

// GET PROFILE
app.get("/me", (req, res) => {
    const token = req.headers.authorization;
    const username = auth(token);

    if (!username) return res.json({ error: "Unauthorized" });

    res.json(db.users[username]);
});

// ======================================================
// 💳 STRIPE CHECKOUT (UPGRADE SYSTEM)
// ======================================================
app.post("/upgrade", async (req, res) => {
    const { token, plan } = req.body;

    const username = auth(token);
    if (!username) return res.json({ error: "Unauthorized" });

    let price = 0;

    if (plan === "pro") price = 500; // $5.00
    if (plan === "elite") price = 1500; // $15.00

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            line_items: [
                {
                    price_data: {
                        currency: "usd",
                        product_data: {
                            name: `AI Friend ${plan.toUpperCase()} Plan`
                        },
                        unit_amount: price
                    },
                    quantity: 1
                }
            ],
            mode: "payment",
            success_url: "https://your-site.com/success",
            cancel_url: "https://your-site.com/cancel"
        });

        res.json({ url: session.url });
    } catch (err) {
        res.json({ error: err.message });
    }
});

// ======================================================
// STRIPE WEBHOOK (ACTIVATE PLAN)
// ======================================================
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
    let event;

    try {
        event = JSON.parse(req.body);
    } catch {
        return res.sendStatus(400);
    }

    if (event.type === "checkout.session.completed") {
        // In real system: map session → user
        console.log("💰 Payment received");
    }

    res.sendStatus(200);
});

// ======================================================
const PORT = 3000;
app.listen(PORT, () => {
    console.log("🚀 AI Friend SaaS LIVE on http://localhost:" + PORT);
});

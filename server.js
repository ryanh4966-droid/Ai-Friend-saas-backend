import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import Stripe from "stripe";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import sqlite3 from "sqlite3";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// =============================
// SERVICES
// =============================
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";

// =============================
// DATABASE (READY FOR POSTGRES MIGRATION)
// =============================
const db = new sqlite3.Database("./saas.db");

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            plan TEXT DEFAULT 'free',
            messagesUsed INTEGER DEFAULT 0,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

// =============================
// SECURITY HELPERS
// =============================
function signToken(user) {
    return jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "7d" });
}

function auth(req) {
    try {
        const token = req.headers.authorization?.split(" ")[1];
        return jwt.verify(token, JWT_SECRET);
    } catch {
        return null;
    }
}

// =============================
// BASIC RATE LIMIT (INVESTOR REQUIREMENT)
// =============================
const requestLog = new Map();

function rateLimit(ip) {
    const now = Date.now();
    const window = 60 * 1000;

    if (!requestLog.has(ip)) requestLog.set(ip, []);
    const times = requestLog.get(ip).filter(t => now - t < window);

    times.push(now);
    requestLog.set(ip, times);

    return times.length < 30; // 30 req/min
}

// =============================
// HEALTH + METRICS (IMPORTANT FOR INVESTORS)
// =============================
app.get("/", (req, res) => {
    db.get("SELECT COUNT(*) as users FROM users", [], (err, row) => {
        res.json({
            status: "AI SaaS LIVE 🚀",
            users: row?.users || 0,
            uptime: process.uptime()
        });
    });
});

// =============================
// REGISTER
// =============================
app.post("/register", async (req, res) => {
    const hash = await bcrypt.hash(req.body.password, 10);

    db.run(
        "INSERT INTO users (username, password) VALUES (?, ?)",
        [req.body.username, hash],
        (err) => {
            if (err) return res.json({ error: "User exists" });
            res.json({ ok: true });
        }
    );
});

// =============================
// LOGIN
// =============================
app.post("/login", (req, res) => {
    db.get(
        "SELECT * FROM users WHERE username = ?",
        [req.body.username],
        async (err, user) => {
            if (!user) return res.json({ error: "not found" });

            const ok = await bcrypt.compare(req.body.password, user.password);
            if (!ok) return res.json({ error: "wrong password" });

            res.json({
                token: signToken(user),
                plan: user.plan
            });
        }
    );
});

// =============================
// CHAT (CORE PRODUCT)
// =============================
app.post("/chat", (req, res) => {
    const ip = req.ip;

    if (!rateLimit(ip)) {
        return res.json({ error: "Rate limit exceeded" });
    }

    const userData = auth(req);
    if (!userData) return res.json({ error: "Unauthorized" });

    db.get("SELECT * FROM users WHERE id = ?", [userData.id], async (err, user) => {

        if (!user) return res.json({ error: "User not found" });

        // FREE TIER LIMIT
        if (user.plan === "free" && user.messagesUsed >= 25) {
            return res.json({
                error: "Free limit reached",
                upgradeRequired: true
            });
        }

        const response = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                {
                    role: "system",
                    content: "You are a premium AI SaaS assistant product."
                },
                {
                    role: "user",
                    content: req.body.message
                }
            ]
        });

        db.run(
            "UPDATE users SET messagesUsed = messagesUsed + 1 WHERE id = ?",
            [user.id]
        );

        res.json({
            reply: response.choices[0].message.content,
            plan: user.plan,
            usage: user.messagesUsed + 1
        });
    });
});

// =============================
// STRIPE SUBSCRIPTION (REAL SAAS MODEL)
// =============================
app.post("/create-checkout", async (req, res) => {
    const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        payment_method_types: ["card"],
        line_items: [{
            price_data: {
                currency: "usd",
                product_data: {
                    name: "AI SaaS Pro"
                },
                unit_amount: 999,
                recurring: { interval: "month" }
            },
            quantity: 1
        }],
        success_url: "https://your-frontend.com/success",
        cancel_url: "https://your-frontend.com/cancel"
    });

    res.json({ url: session.url });
});

// =============================
// STRIPE WEBHOOK (CRITICAL INVESTOR REQUIREMENT)
// =============================
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
    // placeholder for real Stripe event handling
    console.log("Webhook received");
    res.json({ received: true });
});

// =============================
// START SERVER
// =============================
app.listen(PORT, "0.0.0.0", () => {
    console.log("🚀 INVESTOR-GRADE AI SAAS RUNNING ON", PORT);
});

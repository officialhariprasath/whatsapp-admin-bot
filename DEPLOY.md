# 🚀 Render Deployment Guide

Deploy the full WhatsApp Admin Bot to Render with **Render PostgreSQL** (free tier — no separate database vendor required).

---

## Step 1: Fix Your WhatsApp Token (CRITICAL)

Your current token has expired. Before deploying:

1. Go to [developers.facebook.com](https://developers.facebook.com)
2. Select your app → **WhatsApp** → **API Setup**
3. Generate a new **Permanent Access Token**
4. Copy it — you'll need it for Render environment variables

---

## Step 2: Push Code to GitHub

```bash
cd whatsapp-admin-bot
git init
git add .
git commit -m "Ready for Render deployment"
```

Create a new repository on [github.com](https://github.com) (e.g., `whatsapp-admin-bot`), then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/whatsapp-admin-bot.git
git push -u origin main
```

---

## Step 3: Create PostgreSQL on Render (free)

1. In [render.com](https://render.com) dashboard → **New +** → **PostgreSQL**
2. Name: `whatsapp-admin-bot-db` (or any name)
3. Region: **Same region** you will use for the web service (important for low latency and internal URL)
4. Plan: **Free**
5. Click **Create Database**
6. After it provisions, open the database → **Connections**
7. Copy the **Internal Database URL** (starts with `postgresql://`). Use internal URL if your web service runs on Render in the same region; otherwise use the external URL.

Keep this URL — you will add it as `DATABASE_URL` on the web service (Step 4).

---

## Step 4: Create Render Web Service

1. Go to [render.com](https://render.com) → Sign up with GitHub
2. Click **New +** → **Web Service**
3. Connect your GitHub repo `whatsapp-admin-bot`
4. Configure:

| Setting | Value |
|---------|-------|
| **Name** | `whatsapp-admin-bot` |
| **Region** | Choose closest to your users |
| **Runtime** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Plan** | Free |

5. Click **Advanced** → Add Environment Variables:

| Key | Value |
|-----|-------|
| `DATABASE_URL` | *(Paste your Render PostgreSQL **Internal** or **External** URL)* |
| `VERIFY_TOKEN` | `myverifytoken123` |
| `WHATSAPP_TOKEN` | *(Your fresh Meta permanent token)* |
| `PHONE_NUMBER_ID` | `998823059991140` |
| `ADMIN_PASSWORD` | `admin123` *(or your choice)* |
| `PORT` | `10000` |

**Important:** `DATABASE_URL` must be set on the **Web Service** (this app), not only on the PostgreSQL resource. In Render: **PostgreSQL** → **Connections** → copy **Internal Database URL** → **Web Service** → **Environment** → add `DATABASE_URL` with that value. Your repo’s `.env` is **not** used on Render unless you configure it.

6. Click **Create Web Service**

Wait for build to complete (2-3 minutes). You'll get a URL like:
```
https://whatsapp-admin-bot.onrender.com
```

---

## Step 5: Update Meta Webhook URL

1. Go to [developers.facebook.com](https://developers.facebook.com) → Your App → WhatsApp → Configuration
2. Under **Webhooks**, click **Edit**
3. **Callback URL**: `https://whatsapp-admin-bot.onrender.com/webhook`
   *(Replace with your actual Render URL)*
4. **Verify Token**: `myverifytoken123`
5. Click **Verify and Save**
6. Under **Webhook Fields**, subscribe to `messages`

---

## Step 6: Access Your Dashboard

Open your browser:
```
https://whatsapp-admin-bot.onrender.com/login.html
```

**Default Password**: `admin123` *(or whatever you set in `ADMIN_PASSWORD`)*

---

## Step 7: Meta — Deploy for Review & Switch to Live Mode

Do this **after** your Render URL works and the webhook verifies (Step 5).

### A. Finish hosting checklist (you)

1. **Stable URL** — Use your real Render URL (`https://YOUR-SERVICE.onrender.com`). Webhooks must be **HTTPS**.
2. **Env vars match Meta** — `VERIFY_TOKEN` = webhook verify token in Meta. `WHATSAPP_TOKEN` = token from **WhatsApp → API Setup**. `PHONE_NUMBER_ID` = ID for the **same** WhatsApp Business number you use in production (copy from API Setup if you change numbers).
3. **Subscribe to webhooks** — WhatsApp → **Configuration** → Webhook fields include **`messages`** (and any others your app needs).

### B. Business & WhatsApp assets (Meta)

1. **Meta Business Suite / Business Manager** — Your business should own the WhatsApp Business Account (WABA) and phone number.
2. **Business verification** — If Meta asks for it (common for production messaging), complete **Business verification** in Business Manager before or during review.
3. **WhatsApp Business Account** — In **WhatsApp Manager**, ensure the phone number, display name, and quality status are acceptable for how you’ll use the app.

### C. App Review (submit the app)

1. In [developers.facebook.com](https://developers.facebook.com) open your app → **App Review** → **Requests** (or **Permissions and Features**).
2. Request what your integration needs. For Cloud API messaging this often includes WhatsApp-related permissions (e.g. messaging / management — exact names depend on Meta’s current list).
3. Fill in **use case**, **screencast** or **instructions** showing: user opt-in, how messages are handled, and your **privacy policy** URL if required.
4. Submit and respond to Meta’s questions until the submission is **approved**.

### D. Turn the app Live

1. App Dashboard → **Settings** → **Basic** — complete anything Meta marks as required (privacy policy URL, app icon, category, etc.).
2. When review is approved and requirements are green, switch the app from **Development** to **Live** (toggle or **Go Live** — wording varies).
3. **Regenerate or confirm your access token** if Meta asks you to use a production/system token — paste the new value into Render as `WHATSAPP_TOKEN` and redeploy if needed.
4. Test with a **real customer number** (not only test numbers) only after the app is Live and your number is allowed for production traffic.

### E. Free Render tier caveat for reviewers

On the **free** plan the service **sleeps** after idle time; the **first** request can take ~30–60 seconds. For **App Review**, either wake the service before your demo or temporarily upgrade Render so the webhook responds quickly when Meta pings it.

---

## ⚠️ Important Notes

### Free Tier Limitations (Render)
- Service spins down after 15 minutes of inactivity
- First request after spin-down takes ~30 seconds to wake up
- For production, consider upgrading to paid plan

### Free Tier Limitations (Render PostgreSQL)
- Storage and connection limits apply per Render’s current free Postgres terms; enough for testing and moderate use.
- Database and web service are separate resources — create Postgres **before** or **with** the app and paste `DATABASE_URL` into the web service env vars.

### WhatsApp Token Refresh
- Permanent tokens from Meta expire after ~60 days of inactivity
- If messages stop coming through, regenerate the token and update the `WHATSAPP_TOKEN` in Render dashboard

### Changing Password
- Login to dashboard → **Settings** tab → Change password
- Or update `ADMIN_PASSWORD` in Render environment variables and redeploy

---

## 🔄 Updating Your App

After making code changes locally:

```bash
git add .
git commit -m "Your changes"
git push origin main
```

Render will automatically detect the push and redeploy.

---

## 📁 Project Structure (Deployed)

```
whatsapp-admin-bot/
├── index.js          # Server (webhook + API + Socket.IO)
├── db.js             # Database layer (PostgreSQL / `pg`)
├── package.json      # Dependencies
├── public/           # Frontend (served by Express)
│   ├── login.html    # Admin login
│   ├── index.html    # Dashboard
│   ├── app.js        # Frontend logic
│   └── style.css     # Styling
├── exports/          # Generated Excel files
└── .env              # Local config (NOT deployed)
```

---

## 🆘 Troubleshooting

| Problem | Solution |
|---------|----------|
| "Application Error" on Render | Check Render logs (Dashboard → Logs) |
| "Database connection failed" | Verify `DATABASE_URL` matches Render Postgres (internal URL if app is on Render) |
| "Unauthorized" on login | Check `ADMIN_PASSWORD` env var |
| Webhook verification fails | Verify `VERIFY_TOKEN` matches Meta dashboard |
| Messages not coming in | Regenerate `WHATSAPP_TOKEN` in Meta dashboard |
| 404 on static files | Make sure `public/` folder is in GitHub repo |

---

## 🎉 You're Done!

Your WhatsApp Admin Bot is now live on the internet with:
- ✅ Free hosting on Render
- ✅ Free PostgreSQL on Render (linked via `DATABASE_URL`)
- ✅ Secure admin login
- ✅ Real-time dashboard with Socket.IO
- ✅ Automatic Excel generation and downloads
- ✅ Full session history with duplicate numbering
- ✅ Factory reset capability

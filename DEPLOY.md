# 🚀 Render Deployment Guide

Deploy the full WhatsApp Admin Bot to Render with PlanetScale MySQL database.

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

## Step 3: Create PlanetScale Database (Free MySQL)

1. Go to [planetscale.com](https://planetscale.com) → Sign up
2. Click **Create Database**
3. Name: `whatsapp-admin-bot`
4. Region: Choose closest to your users (e.g., `ap-south` for India)
5. Click **Create Database**
6. Go to **Connect** → Select **Connect with: `@planetscale/database` or general MySQL**
7. Copy the **Database URL** (looks like: `mysql://username:password@host.region.psdb.cloud/dbname?sslaccept=strict`)
8. Save this URL — you'll paste it into Render

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
| `DATABASE_URL` | *(Paste your PlanetScale URL here)* |
| `VERIFY_TOKEN` | `myverifytoken123` |
| `WHATSAPP_TOKEN` | *(Your fresh Meta permanent token)* |
| `PHONE_NUMBER_ID` | `998823059991140` |
| `ADMIN_PASSWORD` | `admin123` *(or your choice)* |
| `PORT` | `10000` |

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

## ⚠️ Important Notes

### Free Tier Limitations (Render)
- Service spins down after 15 minutes of inactivity
- First request after spin-down takes ~30 seconds to wake up
- For production, consider upgrading to paid plan

### Free Tier Limitations (PlanetScale)
- 5GB storage
- 1 billion row reads/month
- 10 million row writes/month
- More than enough for this app

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
├── db.js             # Database layer (PlanetScale MySQL)
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
| "Database connection failed" | Verify `DATABASE_URL` is correct from PlanetScale |
| "Unauthorized" on login | Check `ADMIN_PASSWORD` env var |
| Webhook verification fails | Verify `VERIFY_TOKEN` matches Meta dashboard |
| Messages not coming in | Regenerate `WHATSAPP_TOKEN` in Meta dashboard |
| 404 on static files | Make sure `public/` folder is in GitHub repo |

---

## 🎉 You're Done!

Your WhatsApp Admin Bot is now live on the internet with:
- ✅ Free hosting on Render
- ✅ Free MySQL database on PlanetScale
- ✅ Secure admin login
- ✅ Real-time dashboard with Socket.IO
- ✅ Automatic Excel generation and downloads
- ✅ Full session history with duplicate numbering
- ✅ Factory reset capability

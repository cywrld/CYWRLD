# CYWRLD V4 — GitHub-ready edition

This edition is intentionally simplified for GitHub. The repository has only **7 top-level files**. The app creates its own `data/` and `uploads/` folders when it starts.

## Files

- `server.js` — backend, SQLite database, authentication, admin APIs, uploads and analytics
- `index.html` — complete public website (HTML + CSS + JavaScript in one file)
- `admin.html` — complete separate admin dashboard (HTML + CSS + JavaScript in one file)
- `package.json` — Node.js dependencies and start commands
- `.env.example` — safe environment-variable template
- `.gitignore` — prevents passwords, database files, uploads and `node_modules` from entering GitHub
- `README.md` — setup instructions

## Run locally

1. Install Node.js 18 or newer.
2. Open a terminal in this folder.
3. Install packages:

```bash
npm install
```

4. Optional but recommended: copy `.env.example` to `.env` and change the admin password and session secret.
5. Start:

```bash
npm start
```

6. Open `http://localhost:3000`
7. Admin: `http://localhost:3000/admin`

If you do not create a `.env` file, the starter admin is:

- Username: `admin`
- Password: `change-this-password`

Change this before any public deployment.

## Upload to GitHub

On your repository page choose **Add file → Upload files**, select these 7 files together, then commit the upload. Do **not** upload `node_modules`, `.env`, `data`, or `uploads`.

## Important

Only publish or provide downloads for media/software you own or are authorized to distribute.

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'cywrld.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function now() { return new Date().toISOString(); }
function slugify(value) {
  return String(value || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || `item-${Date.now()}`;
}
function uniqueSlug(title, ignoreId = null) {
  const base = slugify(title);
  let candidate = base;
  let i = 2;
  const stmt = ignoreId
    ? db.prepare('SELECT id FROM content WHERE slug = ? AND id != ?')
    : db.prepare('SELECT id FROM content WHERE slug = ?');
  while (ignoreId ? stmt.get(candidate, ignoreId) : stmt.get(candidate)) candidate = `${base}-${i++}`;
  return candidate;
}
function bool(v) { return v === true || v === 1 || v === '1' || v === 'true' || v === 'on'; }
function safeUrl(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (s.startsWith('/uploads/')) return s;
  try {
    const u = new URL(s);
    return ['http:', 'https:'].includes(u.protocol) ? s : '';
  } catch { return s.startsWith('#') ? s : ''; }
}
function publicUser(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, email: row.email, role: row.role, createdAt: row.created_at };
}

function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS content (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      year INTEGER,
      type TEXT NOT NULL DEFAULT 'Movie',
      category TEXT NOT NULL DEFAULT 'Featured',
      genre TEXT DEFAULT '', language TEXT DEFAULT '', country TEXT DEFAULT '',
      duration TEXT DEFAULT '', quality TEXT DEFAULT '', size TEXT DEFAULT '',
      description TEXT DEFAULT '', poster TEXT DEFAULT '', trailer TEXT DEFAULT '',
      featured INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'published' CHECK(status IN ('draft','published')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id INTEGER NOT NULL,
      season INTEGER NOT NULL DEFAULT 1,
      episode INTEGER NOT NULL,
      title TEXT DEFAULT '', description TEXT DEFAULT '', air_date TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      UNIQUE(content_id, season, episode),
      FOREIGN KEY(content_id) REFERENCES content(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id INTEGER NOT NULL,
      episode_id INTEGER,
      label TEXT NOT NULL,
      url TEXT NOT NULL,
      quality TEXT DEFAULT '', size TEXT DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0,
      click_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY(content_id) REFERENCES content(id) ON DELETE CASCADE,
      FOREIGN KEY(episode_id) REFERENCES episodes(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      created_at TEXT NOT NULL,
      FOREIGN KEY(content_id) REFERENCES content(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slot_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      provider TEXT NOT NULL DEFAULT 'placeholder' CHECK(provider IN ('placeholder','adsense')),
      label TEXT DEFAULT 'Advertisement', title TEXT DEFAULT '', text TEXT DEFAULT '', url TEXT DEFAULT '#',
      image_url TEXT DEFAULT '', adsense_client TEXT DEFAULT '', adsense_slot TEXT DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS page_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_id INTEGER,
      path TEXT NOT NULL,
      view_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(content_id) REFERENCES content(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_content_category ON content(category);
    CREATE INDEX IF NOT EXISTS idx_content_created ON content(created_at);
    CREATE INDEX IF NOT EXISTS idx_views_date ON page_views(view_date);
    CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status);
  `);

  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@example.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'change-this-password';
  if (!db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get()) {
    db.prepare('INSERT INTO users (username,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
      .run(adminUsername, adminEmail, bcrypt.hashSync(adminPassword, 12), 'admin', now());
  }

  const adSeed = [
    ['top','Top banner','Sponsored space','Reach the CYWRLD audience','970 × 90 / responsive','#'],
    ['inline','In-feed','Sponsored','Featured partner','Native placement between title rows','#'],
    ['sidebar','Sidebar','Advertisement','Your brand here','300 × 250 / responsive','#'],
    ['download','Download page','Advertisement','Support CYWRLD','Placement above verified download servers','#']
  ];
  const adInsert = db.prepare('INSERT OR IGNORE INTO ads (slot_key,name,label,title,text,url,updated_at) VALUES (?,?,?,?,?,?,?)');
  for (const a of adSeed) adInsert.run(...a, now());

  const settings = db.prepare('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)');
  settings.run('site_name', process.env.SITE_NAME || 'CYWRLD');
  settings.run('tagline', 'Discover. Stream. Download clearly.');
  settings.run('registration_enabled', 'true');

  if (!db.prepare('SELECT id FROM content LIMIT 1').get()) {
    const add = db.prepare(`INSERT INTO content
      (slug,title,year,type,category,genre,language,country,duration,quality,size,description,poster,trailer,featured,status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const demo = [
      ['neon-horizon','Neon Horizon',2026,'Movie','World Cinema','Sci‑Fi, Thriller','English','United Kingdom','1h 48m','1080p','1.4 GB','A courier discovers a signal that predicts brief windows into tomorrow. Fictional demo title.','','',1],
      ['dust-and-drums','Dust & Drums',2026,'Movie','African Stories','Drama, Music','English','Kenya','1h 37m','1080p','1.1 GB','A young producer returns home to record an album and reconnects with a forgotten community rhythm. Fictional demo title.','','',1],
      ['midnight-protocol','Midnight Protocol',2025,'Series','Series','Tech, Mystery','English','Canada','8 episodes','1080p','650 MB / episode','An analyst follows a trail of encrypted broadcasts that appear only at midnight. Fictional demo series.','','',1],
      ['pixel-racers','Pixel Racers',2026,'Animation','Animation','Adventure, Comedy','English','Japan','1h 22m','1080p','980 MB','Two arcade rivals are pulled inside an unfinished racing game. Fictional demo title.','','',0],
      ['seoul-after-rain','Seoul After Rain',2026,'Series','Asian Spotlight','Romance, Drama','Korean','South Korea','12 episodes','1080p','520 MB / episode','A photographer and a café owner keep meeting after summer rainstorms. Fictional demo series.','','',0]
    ];
    const ids = {};
    for (const d of demo) {
      const r = add.run(...d, 'published', now(), now());
      ids[d[0]] = r.lastInsertRowid;
      db.prepare('INSERT INTO downloads (content_id,label,url,quality,size,sort_order,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(r.lastInsertRowid, 'Demo server · sample only', '#demo-download', d[9], d[10], 1, now());
    }
    const epAdd = db.prepare('INSERT INTO episodes (content_id,season,episode,title,description,air_date,created_at) VALUES (?,?,?,?,?,?,?)');
    for (let e=1;e<=4;e++) {
      const er = epAdd.run(ids['midnight-protocol'],1,e,`Episode ${e}`,'Fictional sample episode.','',now());
      db.prepare('INSERT INTO downloads (content_id,episode_id,label,url,quality,size,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(ids['midnight-protocol'],er.lastInsertRowid,`Episode ${e} · Demo server`,'#demo-download','1080p','650 MB',1,now());
    }
    for (let e=1;e<=3;e++) {
      const er = epAdd.run(ids['seoul-after-rain'],1,e,`Episode ${e}`,'Fictional sample episode.','',now());
      db.prepare('INSERT INTO downloads (content_id,episode_id,label,url,quality,size,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(ids['seoul-after-rain'],er.lastInsertRowid,`Episode ${e} · Demo server`,'#demo-download','1080p','520 MB',1,now());
    }
  }
}
initDatabase();

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 12);
    const base = path.basename(file.originalname, path.extname(file.originalname)).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 70);
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${base}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 2 * 1024 * 1024 * 1024 } });
const contentUpload = upload.fields([{ name:'posterFile', maxCount:1 }, { name:'mediaFile', maxCount:1 }]);

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(session({
  name: 'cywrld.sid',
  secret: process.env.SESSION_SECRET || 'replace-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 1000 * 60 * 60 * 24 * 7 }
}));
app.use('/uploads', express.static(UPLOAD_DIR));

function requireUser(req,res,next) {
  if (!req.session.userId) return res.status(401).json({ error:'Sign in required' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  if (!user) return res.status(401).json({ error:'Session expired' });
  req.user = user; next();
}
function requireAdmin(req,res,next) {
  if (!req.session.userId) return res.status(401).json({ error:'Admin sign in required' });
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId);
  if (!user || user.role !== 'admin') return res.status(403).json({ error:'Admin access required' });
  req.user = user; next();
}
function mapContent(row) {
  return row ? {
    id:row.id, slug:row.slug, title:row.title, year:row.year, type:row.type, category:row.category,
    genre:row.genre, language:row.language, country:row.country, duration:row.duration, quality:row.quality,
    size:row.size, description:row.description, poster:row.poster, trailer:row.trailer, featured:!!row.featured,
    status:row.status, createdAt:row.created_at, updatedAt:row.updated_at
  } : null;
}
function mapAd(a) {
  return { id:a.id, key:a.slot_key, name:a.name, enabled:!!a.enabled, provider:a.provider, label:a.label,
    title:a.title, text:a.text, url:a.url, imageUrl:a.image_url, adsenseClient:a.adsense_client, adsenseSlot:a.adsense_slot };
}
function logView(pathname, contentId = null) {
  db.prepare('INSERT INTO page_views (content_id,path,view_date,created_at) VALUES (?,?,?,?)')
    .run(contentId, pathname, new Date().toISOString().slice(0,10), now());
}

app.get('/api/site', (req,res) => {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  res.json(Object.fromEntries(rows.map(r => [r.key,r.value])));
});

app.get('/api/content', (req,res) => {
  const q = String(req.query.q || '').trim();
  const category = String(req.query.category || '').trim();
  const type = String(req.query.type || '').trim();
  const featured = req.query.featured;
  const params = [];
  let where = "WHERE status='published'";
  if (q) { where += ' AND (title LIKE ? OR genre LIKE ? OR category LIKE ? OR description LIKE ?)'; const t=`%${q}%`; params.push(t,t,t,t); }
  if (category) { where += ' AND category=?'; params.push(category); }
  if (type) { where += ' AND type=?'; params.push(type); }
  if (featured === 'true') where += ' AND featured=1';
  const limit = Math.min(Math.max(Number(req.query.limit || 100),1),200);
  const rows = db.prepare(`SELECT * FROM content ${where} ORDER BY datetime(created_at) DESC LIMIT ${limit}`).all(...params);
  res.json(rows.map(mapContent));
});

app.get('/api/categories', (req,res) => {
  res.json(db.prepare("SELECT category,COUNT(*) count FROM content WHERE status='published' GROUP BY category ORDER BY count DESC, category").all());
});

app.get('/api/content/:slug', (req,res) => {
  const row = db.prepare("SELECT * FROM content WHERE slug=? AND status='published'").get(req.params.slug);
  if (!row) return res.status(404).json({ error:'Content not found' });
  logView(`/watch/${row.slug}`, row.id);
  const episodes = db.prepare('SELECT * FROM episodes WHERE content_id=? ORDER BY season,episode').all(row.id).map(ep => ({
    id:ep.id, season:ep.season, episode:ep.episode, title:ep.title, description:ep.description, airDate:ep.air_date,
    downloads: db.prepare('SELECT id,label,quality,size,sort_order FROM downloads WHERE episode_id=? ORDER BY sort_order,id').all(ep.id)
  }));
  const downloads = db.prepare('SELECT id,label,quality,size,sort_order FROM downloads WHERE content_id=? AND episode_id IS NULL ORDER BY sort_order,id').all(row.id);
  const comments = db.prepare(`SELECT comments.id,comments.body,comments.created_at,users.username
    FROM comments JOIN users ON users.id=comments.user_id
    WHERE comments.content_id=? AND comments.status='approved' ORDER BY datetime(comments.created_at) DESC`).all(row.id)
    .map(c => ({ id:c.id, body:c.body, username:c.username, createdAt:c.created_at }));
  res.json({ ...mapContent(row), downloads, episodes, comments });
});

app.get('/api/ads', (req,res) => {
  const ads = db.prepare('SELECT * FROM ads ORDER BY id').all();
  res.json(Object.fromEntries(ads.map(a => [a.slot_key, mapAd(a)])));
});

app.get('/go/:id', (req,res) => {
  const d = db.prepare('SELECT * FROM downloads WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).send('Download link not found');
  db.prepare('UPDATE downloads SET click_count=click_count+1 WHERE id=?').run(d.id);
  const u = safeUrl(d.url);
  if (!u || u.startsWith('#')) return res.redirect('/?demo=1');
  return res.redirect(u);
});

app.get('/api/auth/me', (req,res) => {
  if (!req.session.userId) return res.json({ user:null });
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId)) });
});

app.post('/api/auth/register', (req,res) => {
  const enabled = db.prepare("SELECT value FROM settings WHERE key='registration_enabled'").get()?.value !== 'false';
  if (!enabled) return res.status(403).json({ error:'Registration is disabled' });
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[a-zA-Z0-9_.-]{3,30}$/.test(username)) return res.status(400).json({ error:'Username must be 3–30 letters, numbers, dots, dashes or underscores' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error:'Enter a valid email address' });
  if (password.length < 8) return res.status(400).json({ error:'Password must be at least 8 characters' });
  try {
    const r = db.prepare('INSERT INTO users (username,email,password_hash,role,created_at) VALUES (?,?,?,?,?)')
      .run(username,email,bcrypt.hashSync(password,12),'user',now());
    req.session.userId = Number(r.lastInsertRowid);
    res.status(201).json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid)) });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error:'Username or email already exists' });
    throw e;
  }
});

app.post('/api/auth/login', (req,res) => {
  const identity = String(req.body.identity || req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE OR email=? COLLATE NOCASE').get(identity,identity);
  if (!user || !bcrypt.compareSync(password,user.password_hash)) return res.status(401).json({ error:'Invalid username/email or password' });
  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});
app.post('/api/auth/logout', (req,res) => req.session.destroy(() => res.json({ ok:true })));

app.post('/api/content/:id/comments', requireUser, (req,res) => {
  const body = String(req.body.body || '').trim();
  if (body.length < 2 || body.length > 1500) return res.status(400).json({ error:'Comment must be 2–1500 characters' });
  if (!db.prepare("SELECT id FROM content WHERE id=? AND status='published'").get(req.params.id)) return res.status(404).json({ error:'Content not found' });
  const status = req.user.role === 'admin' ? 'approved' : 'pending';
  const r = db.prepare('INSERT INTO comments (content_id,user_id,body,status,created_at) VALUES (?,?,?,?,?)')
    .run(req.params.id, req.user.id, body, status, now());
  res.status(201).json({ id:Number(r.lastInsertRowid), status });
});

// Admin auth compatibility endpoint
app.post('/api/admin/login', (req,res) => {
  const identity = String(req.body.username || req.body.identity || '').trim();
  const password = String(req.body.password || '');
  const user = db.prepare("SELECT * FROM users WHERE (username=? COLLATE NOCASE OR email=? COLLATE NOCASE) AND role='admin'").get(identity,identity);
  if (!user || !bcrypt.compareSync(password,user.password_hash)) return res.status(401).json({ error:'Invalid admin credentials' });
  req.session.userId = user.id;
  res.json({ ok:true, user:publicUser(user) });
});
app.get('/api/admin/session', (req,res) => {
  const user = req.session.userId ? db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId) : null;
  res.json({ authenticated:!!user && user.role==='admin', user: user?.role==='admin' ? publicUser(user) : null });
});
app.post('/api/admin/logout', (req,res) => req.session.destroy(() => res.json({ ok:true })));

app.get('/api/admin/stats', requireAdmin, (req,res) => {
  const totalTitles = db.prepare('SELECT COUNT(*) n FROM content').get().n;
  const published = db.prepare("SELECT COUNT(*) n FROM content WHERE status='published'").get().n;
  const users = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  const pendingComments = db.prepare("SELECT COUNT(*) n FROM comments WHERE status='pending'").get().n;
  const viewsToday = db.prepare('SELECT COUNT(*) n FROM page_views WHERE view_date=?').get(new Date().toISOString().slice(0,10)).n;
  const clicks = db.prepare('SELECT COALESCE(SUM(click_count),0) n FROM downloads').get().n;
  res.json({ totalTitles,published,users,pendingComments,viewsToday,downloadClicks:clicks });
});

app.get('/api/admin/content', requireAdmin, (req,res) => {
  res.json(db.prepare('SELECT * FROM content ORDER BY datetime(created_at) DESC').all().map(mapContent));
});

app.post('/api/admin/content', requireAdmin, contentUpload, (req,res) => {
  const b = req.body;
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error:'Title is required' });
  const poster = req.files?.posterFile?.[0] ? `/uploads/${req.files.posterFile[0].filename}` : (safeUrl(b.posterUrl) || '');
  const slug = uniqueSlug(b.slug || title);
  const r = db.prepare(`INSERT INTO content
    (slug,title,year,type,category,genre,language,country,duration,quality,size,description,poster,trailer,featured,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      slug,title,Number(b.year)||new Date().getFullYear(),b.type||'Movie',b.category||'Featured',b.genre||'',b.language||'',b.country||'',
      b.duration||'',b.quality||'',b.size||'',b.description||'',poster,safeUrl(b.trailer),bool(b.featured)?1:0,b.status==='draft'?'draft':'published',now(),now()
    );
  const id = Number(r.lastInsertRowid);
  if (req.files?.mediaFile?.[0]) {
    db.prepare('INSERT INTO downloads (content_id,label,url,quality,size,sort_order,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id,b.uploadLabel||'Primary server',`/uploads/${req.files.mediaFile[0].filename}`,b.quality||'',b.size||'',1,now());
  }
  if (safeUrl(b.downloadUrl)) {
    db.prepare('INSERT INTO downloads (content_id,label,url,quality,size,sort_order,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id,b.downloadLabel||'External server',safeUrl(b.downloadUrl),b.quality||'',b.size||'',2,now());
  }
  res.status(201).json(mapContent(db.prepare('SELECT * FROM content WHERE id=?').get(id)));
});

app.put('/api/admin/content/:id', requireAdmin, contentUpload, (req,res) => {
  const old = db.prepare('SELECT * FROM content WHERE id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error:'Content not found' });
  const b=req.body;
  const title=String(b.title || old.title).trim();
  const poster=req.files?.posterFile?.[0] ? `/uploads/${req.files.posterFile[0].filename}` : (safeUrl(b.posterUrl)||old.poster);
  const slug = b.slug ? uniqueSlug(b.slug, old.id) : old.slug;
  db.prepare(`UPDATE content SET slug=?,title=?,year=?,type=?,category=?,genre=?,language=?,country=?,duration=?,quality=?,size=?,description=?,poster=?,trailer=?,featured=?,status=?,updated_at=? WHERE id=?`).run(
    slug,title,Number(b.year)||old.year,b.type||old.type,b.category||old.category,b.genre??old.genre,b.language??old.language,b.country??old.country,
    b.duration??old.duration,b.quality??old.quality,b.size??old.size,b.description??old.description,poster,b.trailer!==undefined?safeUrl(b.trailer):old.trailer,
    bool(b.featured)?1:0,b.status==='draft'?'draft':'published',now(),old.id
  );
  if (req.files?.mediaFile?.[0]) {
    db.prepare('INSERT INTO downloads (content_id,label,url,quality,size,sort_order,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(old.id,b.uploadLabel||'Uploaded server',`/uploads/${req.files.mediaFile[0].filename}`,b.quality||'',b.size||'',99,now());
  }
  if (safeUrl(b.downloadUrl)) {
    db.prepare('INSERT INTO downloads (content_id,label,url,quality,size,sort_order,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(old.id,b.downloadLabel||'External server',safeUrl(b.downloadUrl),b.quality||'',b.size||'',100,now());
  }
  res.json(mapContent(db.prepare('SELECT * FROM content WHERE id=?').get(old.id)));
});

app.delete('/api/admin/content/:id', requireAdmin, (req,res) => {
  const r=db.prepare('DELETE FROM content WHERE id=?').run(req.params.id);
  if (!r.changes) return res.status(404).json({ error:'Content not found' });
  res.json({ ok:true });
});

app.get('/api/admin/content/:id/episodes', requireAdmin, (req,res) => {
  const rows=db.prepare('SELECT * FROM episodes WHERE content_id=? ORDER BY season,episode').all(req.params.id);
  res.json(rows.map(e=>({ ...e, downloads:db.prepare('SELECT * FROM downloads WHERE episode_id=? ORDER BY sort_order,id').all(e.id) })));
});
app.post('/api/admin/content/:id/episodes', requireAdmin, (req,res) => {
  if (!db.prepare('SELECT id FROM content WHERE id=?').get(req.params.id)) return res.status(404).json({ error:'Content not found' });
  try {
    const r=db.prepare('INSERT INTO episodes (content_id,season,episode,title,description,air_date,created_at) VALUES (?,?,?,?,?,?,?)').run(
      req.params.id,Number(req.body.season)||1,Number(req.body.episode)||1,req.body.title||'',req.body.description||'',req.body.airDate||'',now());
    res.status(201).json(db.prepare('SELECT * FROM episodes WHERE id=?').get(r.lastInsertRowid));
  } catch(e) { if(String(e.message).includes('UNIQUE')) return res.status(409).json({ error:'That season/episode already exists' }); throw e; }
});
app.put('/api/admin/episodes/:id', requireAdmin, (req,res) => {
  const e=db.prepare('SELECT * FROM episodes WHERE id=?').get(req.params.id); if(!e) return res.status(404).json({ error:'Episode not found' });
  db.prepare('UPDATE episodes SET season=?,episode=?,title=?,description=?,air_date=? WHERE id=?').run(Number(req.body.season)||e.season,Number(req.body.episode)||e.episode,req.body.title??e.title,req.body.description??e.description,req.body.airDate??e.air_date,e.id);
  res.json(db.prepare('SELECT * FROM episodes WHERE id=?').get(e.id));
});
app.delete('/api/admin/episodes/:id', requireAdmin, (req,res) => { const r=db.prepare('DELETE FROM episodes WHERE id=?').run(req.params.id); res.status(r.changes?200:404).json(r.changes?{ok:true}:{error:'Episode not found'}); });

app.get('/api/admin/content/:id/downloads', requireAdmin, (req,res) => res.json(db.prepare('SELECT * FROM downloads WHERE content_id=? ORDER BY episode_id,sort_order,id').all(req.params.id)));
app.post('/api/admin/content/:id/downloads', requireAdmin, upload.single('file'), (req,res) => {
  if (!db.prepare('SELECT id FROM content WHERE id=?').get(req.params.id)) return res.status(404).json({ error:'Content not found' });
  const url=req.file?`/uploads/${req.file.filename}`:safeUrl(req.body.url);
  if(!url) return res.status(400).json({ error:'Upload a file or enter a valid URL' });
  const episodeId=req.body.episodeId?Number(req.body.episodeId):null;
  if(episodeId && !db.prepare('SELECT id FROM episodes WHERE id=? AND content_id=?').get(episodeId,req.params.id)) return res.status(400).json({ error:'Episode does not belong to this title' });
  const r=db.prepare('INSERT INTO downloads (content_id,episode_id,label,url,quality,size,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?)').run(req.params.id,episodeId,req.body.label||'Download server',url,req.body.quality||'',req.body.size||'',Number(req.body.sortOrder)||0,now());
  res.status(201).json(db.prepare('SELECT * FROM downloads WHERE id=?').get(r.lastInsertRowid));
});
app.put('/api/admin/downloads/:id', requireAdmin, (req,res) => {
  const d=db.prepare('SELECT * FROM downloads WHERE id=?').get(req.params.id); if(!d) return res.status(404).json({ error:'Download not found' });
  db.prepare('UPDATE downloads SET label=?,url=?,quality=?,size=?,sort_order=? WHERE id=?').run(req.body.label??d.label,safeUrl(req.body.url)||d.url,req.body.quality??d.quality,req.body.size??d.size,Number(req.body.sortOrder??d.sort_order),d.id);
  res.json(db.prepare('SELECT * FROM downloads WHERE id=?').get(d.id));
});
app.delete('/api/admin/downloads/:id', requireAdmin, (req,res) => { const r=db.prepare('DELETE FROM downloads WHERE id=?').run(req.params.id); res.status(r.changes?200:404).json(r.changes?{ok:true}:{error:'Download not found'}); });

app.get('/api/admin/comments', requireAdmin, (req,res) => {
  res.json(db.prepare(`SELECT comments.*,users.username,content.title content_title FROM comments
    JOIN users ON users.id=comments.user_id JOIN content ON content.id=comments.content_id ORDER BY datetime(comments.created_at) DESC`).all());
});
app.put('/api/admin/comments/:id', requireAdmin, (req,res) => {
  const status=['pending','approved','rejected'].includes(req.body.status)?req.body.status:null;
  if(!status) return res.status(400).json({ error:'Invalid status' });
  const r=db.prepare('UPDATE comments SET status=? WHERE id=?').run(status,req.params.id);
  res.status(r.changes?200:404).json(r.changes?{ok:true}:{error:'Comment not found'});
});
app.delete('/api/admin/comments/:id', requireAdmin, (req,res) => { const r=db.prepare('DELETE FROM comments WHERE id=?').run(req.params.id); res.status(r.changes?200:404).json(r.changes?{ok:true}:{error:'Comment not found'}); });

app.get('/api/admin/users', requireAdmin, (req,res) => {
  res.json(db.prepare('SELECT id,username,email,role,created_at FROM users ORDER BY datetime(created_at) DESC').all());
});

app.get('/api/admin/ads', requireAdmin, (req,res) => res.json(db.prepare('SELECT * FROM ads ORDER BY id').all().map(mapAd)));
app.put('/api/admin/ads/:key', requireAdmin, (req,res) => {
  const a=db.prepare('SELECT * FROM ads WHERE slot_key=?').get(req.params.key); if(!a) return res.status(404).json({ error:'Ad slot not found' });
  const p=req.body.provider==='adsense'?'adsense':'placeholder';
  db.prepare(`UPDATE ads SET enabled=?,provider=?,label=?,title=?,text=?,url=?,image_url=?,adsense_client=?,adsense_slot=?,updated_at=? WHERE slot_key=?`).run(
    bool(req.body.enabled)?1:0,p,req.body.label??a.label,req.body.title??a.title,req.body.text??a.text,safeUrl(req.body.url)||'#',safeUrl(req.body.imageUrl),req.body.adsenseClient||'',req.body.adsenseSlot||'',now(),a.slot_key);
  res.json(mapAd(db.prepare('SELECT * FROM ads WHERE slot_key=?').get(a.slot_key)));
});

app.get('/api/admin/settings', requireAdmin, (req,res) => {
  const rows=db.prepare('SELECT key,value FROM settings').all(); res.json(Object.fromEntries(rows.map(r=>[r.key,r.value])));
});
app.put('/api/admin/settings', requireAdmin, (req,res) => {
  const up=db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const allowed=['site_name','tagline','registration_enabled'];
  const tx=db.transaction(()=>{ for(const k of allowed) if(req.body[k]!==undefined) up.run(k,String(req.body[k])); }); tx();
  res.json({ ok:true });
});

app.get('/api/admin/analytics', requireAdmin, (req,res) => {
  const days=Math.min(Math.max(Number(req.query.days||14),7),90);
  const daily=db.prepare(`SELECT view_date date,COUNT(*) views FROM page_views WHERE view_date>=date('now', ?) GROUP BY view_date ORDER BY view_date`).all(`-${days-1} days`);
  const top=db.prepare(`SELECT content.id,content.title,content.slug,COUNT(page_views.id) views FROM content LEFT JOIN page_views ON page_views.content_id=content.id GROUP BY content.id ORDER BY views DESC LIMIT 10`).all();
  const downloads=db.prepare('SELECT downloads.id,downloads.label,downloads.click_count clicks,content.title FROM downloads JOIN content ON content.id=downloads.content_id ORDER BY click_count DESC LIMIT 10').all();
  res.json({ daily,top,downloads });
});

app.get('/', (req,res) => res.sendFile(path.join(ROOT,'index.html')));
app.get('/watch/:slug', (req,res) => res.sendFile(path.join(ROOT,'index.html')));
app.get('/account', (req,res) => res.sendFile(path.join(ROOT,'index.html')));
app.get('/admin', (req,res) => res.sendFile(path.join(ROOT,'admin.html')));
app.get('/admin/dashboard', (req,res) => res.sendFile(path.join(ROOT,'admin.html')));

app.use('/api', (req,res) => res.status(404).json({ error:'API route not found' }));
app.use((err,req,res,next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error:err.message });
  res.status(500).json({ error:'Server error' });
});

app.listen(PORT, () => console.log(`CYWRLD V4 running at http://localhost:${PORT}`));

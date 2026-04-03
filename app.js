const express = require('express');
const path = require('path');
const fs = require('fs');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcrypt');
const helmet = require('helmet');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(helmet());
app.use(cors());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/\s+/g, '_')}`)
  }),
  limits: { fileSize: 30 * 1024 * 1024 }
});

const DATA_FILE = path.join(__dirname, 'data.json');
const { MongoClient } = require('mongodb');
const MONGO_URI = process.env.MONGODB_URI || '';
const MONGO_DBNAME = process.env.MONGODB_DBNAME || 'jiaozi';
let mongoClient = null;
let usersColl = null;
let projectsColl = null;

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const adminHash = bcrypt.hashSync('gys112700', 10);
    const initial = {
      users: [{ id: uuidv4(), username: 'gys112700', password: adminHash, role: 'admin' }],
      projects: []
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2), 'utf8');
    return initial;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

async function initMongo() {
  if (!MONGO_URI) return;
  try {
    mongoClient = new MongoClient(MONGO_URI);
    await mongoClient.connect();
    const db = mongoClient.db(MONGO_DBNAME);
    usersColl = db.collection('users');
    projectsColl = db.collection('projects');

    const adminExists = await usersColl.findOne({ username: 'gys112700' });
    if (!adminExists) {
      const adminHash = bcrypt.hashSync('gys112700', 10);
      await usersColl.insertOne({ id: uuidv4(), username: 'gys112700', password: adminHash, role: 'admin' });
    }

    const dbUsers = await usersColl.find().toArray();
    const dbProjects = await projectsColl.find().toArray();
    if (dbUsers.length) {
      data.users = dbUsers;
    }
    if (dbProjects.length) {
      data.projects = dbProjects;
    }

    console.log('MongoDB 已连接, 数据同步已完成');
  } catch (err) {
    console.error('MongoDB 连接失败:', err.message);
  }
}

async function syncUserToMongo(user) {
  if (usersColl) {
    await usersColl.updateOne({ username: user.username }, { $set: user }, { upsert: true });
  }
}

async function syncProjectToMongo(project) {
  if (projectsColl) {
    await projectsColl.updateOne({ id: project.id }, { $set: project }, { upsert: true });
  }
}


function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

const data = loadData();
initMongo().catch((err) => console.error('初始Mongo失败', err));

app.use(session({
  secret: 'jiaozi-shenqi-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 }
}));

app.use((req, res, next) => {
  res.locals.user = req.session.user;
  next();
});

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin') {
    return res.status(403).send('仅管理员可访问');
  }
  next();
}

app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/register');
  res.redirect('/dashboard');
});

app.get('/register', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('register', { error: null });
});

app.post('/register', async (req, res) => {
  const { username, password, confirm } = req.body;
  if (!username || !password || !confirm) {
    return res.render('register', { error: '请填写全部字段。' });
  }
  if (password !== confirm) {
    return res.render('register', { error: '两次密码不一致。' });
  }

  const exists = usersColl
    ? await usersColl.findOne({ username })
    : data.users.find((u) => u.username === username);

  if (exists) {
    return res.render('register', { error: '用户名已存在。' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const user = { id: uuidv4(), username, password: hash, role: 'user' };
  data.users.push(user);
  saveData(data);
  await syncUserToMongo(user);

  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.redirect('/dashboard');
});

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = usersColl
    ? await usersColl.findOne({ username })
    : data.users.find((u) => u.username === username);

  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.render('login', { error: '用户名或密码错误。' });
  }
  req.session.user = { id: user.id, username: user.username, role: user.role };
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// 公共 API（支持跨设备搜索与数据显示）
app.get('/api/projects', async (req, res) => {
  const projects = projectsColl ? await projectsColl.find().toArray() : data.projects;
  res.json(projects);
});

app.get('/api/project/:id', async (req, res) => {
  const project = projectsColl
    ? await projectsColl.findOne({ id: req.params.id })
    : data.projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  res.json(project);
});

app.get('/api/users', requireLogin, requireAdmin, async (req, res) => {
  const users = usersColl ? await usersColl.find().toArray() : data.users;
  res.json(users.map((u) => ({ id: u.id, username: u.username, role: u.role })));
});

let sseClients = [];

app.get('/events', requireLogin, (req, res) => {
  res.writeHead(200, {
    Connection: 'keep-alive',
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
  });
  res.write('\n');

  const clientId = uuidv4();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  req.on('close', () => {
    sseClients = sseClients.filter((c) => c.id !== clientId);
  });
});

function notifyProjectUpdate(dataPayload) {
  sseClients.forEach((client) => {
    client.res.write(`event: project-update\n`);
    client.res.write(`data: ${JSON.stringify(dataPayload)}\n\n`);
  });
}

function syncData() {
  saveData(data);
  notifyProjectUpdate({ type: 'sync', total: data.projects.length, timestamp: Date.now() });
}

app.get('/dashboard', requireLogin, async (req, res) => {
  const q = (req.query.q || '').toLowerCase();
  let projects = data.projects;
  if (projectsColl) {
    projects = await projectsColl.find().toArray();
  }
  const filtered = projects.filter((p) => {
    if (!q) return true;
    return p.title.toLowerCase().includes(q) || p.tags.join(',').toLowerCase().includes(q);
  });
  res.render('dashboard', { projects: filtered, query: req.query.q || '' });
});

app.get('/projects/:id', requireLogin, async (req, res) => {
  let project = data.projects.find((p) => p.id === req.params.id);
  if (projectsColl) {
    project = await projectsColl.findOne({ id: req.params.id });
  }
  if (!project) return res.status(404).send('项目不存在。');
  res.render('project', { project });
});

app.get('/create', requireLogin, requireAdmin, (req, res) => {
  res.render('create', { error: null });
});

app.post('/create', requireLogin, requireAdmin, upload.fields([
  { name: 'imageFile', maxCount: 1 },
  { name: 'diagramFile', maxCount: 1 },
  { name: 'videoFile', maxCount: 1 }
]), async (req, res) => {
  const { title, description, imageUrl, diagramUrl, linkUrl, videoUrl, tags } = req.body;
  if (!title || !description || !linkUrl) {
    return res.render('create', { error: '项目名称、描述、链接为必填。' });
  }

  const imageFile = req.files?.imageFile?.[0];
  const diagramFile = req.files?.diagramFile?.[0];
  const videoFile = req.files?.videoFile?.[0];

  const project = {
    id: uuidv4(),
    title,
    description,
    imageUrl: imageFile ? `/uploads/${path.basename(imageFile.path)}` : (imageUrl || '/images/default.png'),
    diagramUrl: diagramFile ? `/uploads/${path.basename(diagramFile.path)}` : (diagramUrl || '/images/default.png'),
    linkUrl,
    videoUrl: videoFile ? `/uploads/${path.basename(videoFile.path)}` : (videoUrl || ''),
    tags: tags ? tags.split(',').map((s) => s.trim()) : [],
    createdAt: new Date().toISOString()
  };

  data.projects.push(project);
  saveData(data);
  await syncProjectToMongo(project);
  syncData();
  res.redirect('/dashboard');
});

app.post('/projects/:id/delete', requireLogin, requireAdmin, async (req, res) => {
  const projectId = req.params.id;
  data.projects = data.projects.filter((p) => p.id !== projectId);
  saveData(data);
  if (projectsColl) {
    await projectsColl.deleteOne({ id: projectId });
  }
  syncData();
  res.redirect('/dashboard');
});

app.get('/sitemap.xml', (req, res) => {
  const host = req.protocol + '://' + req.get('host');
  const urls = [`<url><loc>${host}/</loc></url>`, `<url><loc>${host}/dashboard</loc></url>`];
  data.projects.forEach((p) => urls.push(`<url><loc>${host}/projects/${p.id}</loc></url>`));
  res.type('application/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`);
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.send('User-agent: *\nAllow: /\nSitemap: ' + req.protocol + '://' + req.get('host') + '/sitemap.xml');
});

app.use((req, res) => {
  res.status(404).send('页面未找到。');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('饺子的神奇小窝启动于端口', PORT, '（0.0.0.0 可外部访问）'));

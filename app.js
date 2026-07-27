
require('dotenv').config();
require('./db');
require('./auth');


const passport = require('passport');
const express = require('express');
const path = require('path');

const routes = require('./routes/index');
const list = require('./routes/list');
const listItem = require('./routes/list-item');
const productview = require('./routes/product-view');
const profile = require('./routes/profile');
const flash = require('connect-flash');

const app = express();

// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'hbs');

// running behind a reverse proxy on Vercel/Render — required for correct
// client IPs and secure cookies
app.set('trust proxy', 1);

// enable sessions — backed by MongoDB so they survive serverless instance
// recycling (in-memory sessions are lost between invocations on Vercel)
const session = require('express-session');
const MongoStore = require('connect-mongo');
const sessionOptions = {
    secret: process.env.SESSION_SECRET || 'insecure-dev-secret',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI })
};
app.use(session(sessionOptions));

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

// passport setup
app.use(passport.initialize());
app.use(passport.session());
// app.use(flash());



// make user data available to all templates
app.use((req, res, next) => {
  res.locals.user = req.user;
  next();
});

app.use('/', routes);
app.use('/list', list);
app.use('/product-view',productview);
app.use('/list-item', listItem);
app.use('/profile', profile);



// on Vercel the app is imported by api/index.js and run as a serverless
// function; only bind a port when run directly (local dev, Render, etc.)
if (require.main === module) {
    const port = process.env.PORT || 3000;
    app.listen(port);
}

module.exports = app;

const express = require('express'), 
    argon2 = require('argon2'),
    mongoose = require('mongoose'), 
    Song = mongoose.model('Song'),
    User = mongoose.model('User'),
    router = express.Router(),
    passport = require('passport');

// passport.use(new LocalStrategy(User.authenticate()));

router.get('/logout', (req, res) => {
  req.logout();
  res.redirect('/');
});

router.get('/login', (req, res) => {
    console.log('enter login');
    res.render('login');
});

router.get('/register', (req, res) => {
    console.log('enter register');
    res.render('register');
});

router.get('/', (req, res) => {
  Song.find({},
    function(err,allSongs){
      if(err){
        console.log(err);
      } else {
        // console.log(allSongs);
        res.render('home',{
          content:allSongs
        });
      }
    });
});

router.post('/register', (req, res) =>  {
  console.log(req.body);
  const {username, password} = req.body;
  // const existingUser = await User.findOne({username: username}).exec();
  User.register(new User({username,password}), req.body.password, (err, user) => {
    if(user){
      console.log("Here's the User:",user);
      console.log(`${username}'s account created successfully!`);
    }
    if (err) {
      console.log(err);
      res.render('register',{message:'Your registration information is not valid. Try again.'});
    } else {
      passport.authenticate('local')(req, res, function() {
      res.redirect('/');
      });
    }
  });
});

router.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user) => {
    if(user) {
      req.logIn(user, (err) => {
        res.redirect('/');
      });
    } else {
      res.render('login', {message:'Your login or password is incorrect.'});
    }
  })(req, res, next);
});

module.exports = router;

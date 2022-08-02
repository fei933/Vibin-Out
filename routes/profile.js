// const { product } = require('prelude-ls');
// const scentsFeatures = require('./scent_feature_mapping.json');
// console.log(scents_feature.floral);

const express = require('express'),
    router = express.Router(),
    mongoose = require('mongoose'),
    Playlist = mongoose.model('Playlist'),
    Product = mongoose.model('Product'),
    Song = mongoose.model('Song');

router.get('/', (req, res) => {
    console.log(req.user);
    if(!req.user){
        res.redirect('/');
    }
    Playlist.find({username:req.user.username},function(err,userPlaylists){
        res.render('profile.hbs', {
            userName: req.user.username,
            userGenre: req.user.favgenres,
            userScent: req.user.favscents,
            list: userPlaylists});
    });
});

router.post('/',(req,res)=>{
    if(!req.user){
        res.redirect('/');
    }else {
        console.log(req.body);
        Playlist.findOneAndDelete({_id:req.body.listId}).exec((err)=>{
            if(err){console.log(err);}
        });
        res.redirect("/profile");
    }
});

module.exports = router;
const { product } = require('prelude-ls');
const scentsFeatures = require('./scent_feature_mapping.json');
// console.log(scents_feature.floral);

// Spotify
let SpotifyWebApi = require('spotify-web-api-node');
const spotifyApi = new SpotifyWebApi({
	clientId: process.env.CLIENT_ID,
	clientSecret: process.env.CLIENT_SECRET
});

const express = require('express'),
	router = express.Router(),
	mongoose = require('mongoose'),
	Playlist = mongoose.model('Playlist'),
	Product = mongoose.model('Product'),
	Song = mongoose.model('Song'),
	mongoose_fuzzy_searching = require('mongoose-fuzzy-searching'); // fuzzy search

// Get access token from Spotify, credential grant authorization method, no need to sign in
// the code snippet is revised from https://github.com/thelinmichael/spotify-web-api-node/blob/master/examples/client-credentials.js#L1
spotifyApi.clientCredentialsGrant().
then(function(data) {
	spotifyApi.setAccessToken(data.body['access_token']);
	return data.body['access_token'];
  })
.then(function(data) {
	console.log(data);
  })
.catch(function(err) {
	if(err){console.log('Something went wrong:', err.message);}
});


router.get('/', (req, res) => {
	// Playlist.find({user: req.user ? req.user._id : undefined}, (err, lists, count) => {
	// 	res.render('list-all.hbs', {lists:lists});
	// });
	Playlist.find({}, (err, allpl, count) => {
		res.render('list-all.hbs', {pl:allpl});
	});
});

router.post('/',(req,res)=>{
	console.log(req.body);
	if(req.body.query!==""){
		// using fuzzySeach
		Playlist.fuzzySearch(req.body.query).exec((err, searchRes)=>{
			if(err){console.log(err);}
			console.log(searchRes);
			res.render('list-all.hbs', {pl:searchRes});
		});
	}else{
		res.redirect("/list");
	}
});

router.get('/create', (req, res) => {
	if(req.user){
		res.render('list-create.hbs');
	} else{
		res.redirect('/'); 
		console.log('unauthorized');
	}
});

router.post('/create', (req, res) => {
	if(!req.user){
		res.redirect('/'); 
		console.log('unauthorized');
	}
	console.log(req.body);
	const {name,prodname,prodbrand,prodtype,proddescript,generatetype,scent} = req.body;
	let p = new Product({
        name: prodname,
        category: prodtype,
        brand: prodbrand,
        description: proddescript,
		scent: scent
	});
	Product.findOne({name: prodname.toLowerCase(),category:prodtype}, function(err, result) {
		console.log(result);
		if(!result){
			p.save((err)=>{if(err){console.log(err);}});
		}else{
			p = result;
		}
	});
	if(generatetype === "recommendation"){
		let songToAdd = [];
		let artists, track;
		const props = getProps(p.scent,artists,track);
		spotifyApi.getRecommendations(props)
		.then(function(data) {
			const recommendations = data.body;
			// console.log(recommendations);
			// create songs and put them into the songToAdd array
			songToAdd = recommendations.tracks.map(function(song){
				s = new Song({
					name: song.name,
					artists: song.artists.map(a => a['name']),
					album: song.album.name,
					cover: song.album.images.map(g => g['url'])[1],
					href: song.href, // from/for spotfy
					id: song.id, // from spotify
					external_urls: song.external_urls.spotify,
					explicit : song.explicit, // from spotify
					popularity: song.popularity, // from spotify
					// cover: 
				});
				// save song to database
				s.save((err, song, count) => {
					if(err){
						console.log(err);
					}
				});
				console.log(s);
				return s;
			});
			// create playlist object that contains everything
			new Playlist({
				user: req.user._id,
				username: req.user.username,
				name: name,
				productname: prodname,
				product: p,
				contents: songToAdd,
				createdAt: Date.now()
			}).save((err, list, count) => {
				res.redirect(`/list/${list.slug}`);
				// res.redirect('/');
			});
		}, function(err) {
		console.log("Something went wrong!", err);
		});
	}else{
		new Playlist({
			user: req.user._id,
			username: req.user.username,
			name: name,
			productname: prodname,
			product: p,
			createdAt: Date.now()
		}).save((err, list, count) => {
			res.redirect(`/list/${list.slug}`);
		});
	}
});

router.get('/:slug', (req, res) => {
	const {slug} = req.params;
	console.log("current user:", req.user);
	let auth = false;

	Playlist.findOne({slug},(err, playlist, count) => {
		console.log("PLAYLIST", playlist);
		const songIds = playlist.contents.map((s) => {
			return s.valueOf();
		});
		// console.log("contents",playlist.contents);
		// console.log("song ids",songIds);
		if(req.user){
			if(req.user.username === playlist.username){
				console.log("same author!");
				auth = true;
			}
		}
		Song.find({ _id: songIds}).exec((err,result,count)=>{
			let currentSongPlay;
			if(Object.keys(req.query).length !== 0 && req.query.playSongId){
				currentSongPlay = req.query.playSongId;
			}else{
				currentSongPlay = result.map((s)=>s.id)[0];
			}
			console.log(currentSongPlay);
				Product.findOne({_id:playlist.product.valueOf()}).exec((err,sc)=>{
				const thisScents = sc.scent;
				res.render('list-slug.hbs',{
					list: playlist,
					time:playlist.createdAt.toLocaleDateString(),
					scent: thisScents,
					category: sc.category,
					songs: result,
					userMatch:auth,
					currentSongId: currentSongPlay
				});
			});
		});		
	});
});

router.post('/:slug', (req, res) => {
	const {slug} = req.params;
	const songId = req.body.songId;
	const songName = req.body.songName;
	console.log(req.body);
	let curId = "0E6uWutxRjIDhleURR92do";
	Song.findOne({id:songId,name:songName}).exec((err,targetSong)=>{
		if(err){console.log(err);}
		console.log("target song:",targetSong);
		console.log("slug",slug);
		Playlist.findOneAndUpdate({slug:slug},{$pullAll:{contents:[targetSong]}}).exec((err)=>{
			if(err){console.log(err);}
			res.redirect(`/list/${slug}`);
		});
	});


});


function getProps(scent,artists = null,track = null){
	console.log(scent);
	const res = {};
	const allGenre = [];
	scent.forEach( e => {
		allGenre.push(...scentsFeatures[e]['seed_genres'].split(","));
	});
	const allArtist = [];
	scent.forEach(e => {
		allArtist.push(...scentsFeatures[e]['seed_artists'].split(","));
	});
	const allTrack = [];
	scent.forEach(e => {
		allTrack.push(...scentsFeatures[e]['seed_tracks'].split(","));
	});
	// console.log(allGenre, allArtist, allTrack);
	allGenre.sort((a,b)=>Math.random()-0.6);
	allArtist.sort((a,b)=>Math.random()-0.5);
	allTrack.sort((a,b)=>Math.random()-0.2);
	res['seed_genres'] = `${allGenre[0]},${allGenre[1]}`;
	res['seed_artists'] = `${allArtist[0]}`;
	res['seed_tracks'] = `${allTrack[0]},${allTrack[1]}`;
	res['limit'] = 15;
	if(scent.includes("spicy")){
		res['min_danceability'] = 0.6;
		res['target_tempo'] = 120;
	}
	if(scent.includes("oceanic")){
		res['target_liveness'] = 0.6;
	}
	if(scent.includes("woody")){
		res['max_energy'] = 0.55;
	}
	if(scent.includes("floral")){
		res['target_liveness'] = (res['target_liveness']+0.4)/2;
		res['max_energy'] = Math.min(res['max_energy'],0.6);
	}
	console.log(res);
	return res;
}


/*
// Spotify API - from https://github.com/spotify/web-api-auth-examples/blob/master/authorization_code/app.js

var request = require('request'); // "Request" library

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;


var generateRandomString = function(length) {
	var text = '';
	var possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  
	for (var i = 0; i < length; i++) {
	  text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
  };
  
var stateKey = 'spotify_auth_state';

router.get('/spotify-login', function(req, res) {

	var state = generateRandomString(16);
	res.cookie(stateKey, state);
  
	// your application requests authorization
	var scope = 'user-read-private user-read-email';
	res.redirect('https://accounts.spotify.com/authorize?' +
	  querystring.stringify({
		response_type: 'code',
		client_id: CLIENT_ID,
		scope: scope,
		redirect_uri: REDIRECT_URI,
		state: state
	  }));
  });

  router.get('/callback', function(req, res) {

	// your application requests refresh and access tokens
	// after checking the state parameter
  
	var code = req.query.code || null;
	var state = req.query.state || null;
	var storedState = req.cookies ? req.cookies[stateKey] : null;
  
	if (state === null || state !== storedState) {
	  res.redirect('/#' +
		querystring.stringify({
		  error: 'state_mismatch'
		}));
	} else {
	  res.clearCookie(stateKey);
	  var authOptions = {
		url: 'https://accounts.spotify.com/api/token',
		form: {
		  code: code,
		  redirect_uri: redirect_uri,
		  grant_type: 'authorization_code'
		},
		headers: {
		  'Authorization': 'Basic ' + (new Buffer(client_id + ':' + client_secret).toString('base64'))
		},
		json: true
	  };
  
	  request.post(authOptions, function(error, response, body) {
		if (!error && response.statusCode === 200) {
  
		  var access_token = body.access_token,
			  refresh_token = body.refresh_token;
  
		  var options = {
			url: 'https://api.spotify.com/v1/me',
			headers: { 'Authorization': 'Bearer ' + access_token },
			json: true
		  };
  
		  // use the access token to access the Spotify Web API
		  request.get(options, function(error, response, body) {
			console.log(body);
		  });
  
		  // we can also pass the token to the browser to make requests from there
		  res.redirect('/#' +
			querystring.stringify({
			  access_token: access_token,
			  refresh_token: refresh_token
			}));
		} else {
		  res.redirect('/#' +
			querystring.stringify({
			  error: 'invalid_token'
			}));
		}
	  });
	}
  });
  
  router.get('/refresh_token', function(req, res) {
  
	// requesting access token from refresh token
	var refresh_token = req.query.refresh_token;
	var authOptions = {
	  url: 'https://accounts.spotify.com/api/token',
	  headers: { 'Authorization': 'Basic ' + (new Buffer(client_id + ':' + client_secret).toString('base64')) },
	  form: {
		grant_type: 'refresh_token',
		refresh_token: refresh_token
	  },
	  json: true
	};
  
	request.post(authOptions, function(error, response, body) {
	  if (!error && response.statusCode === 200) {
		var access_token = body.access_token;
		console.log(access_token);
		res.send({
		  'access_token': access_token
		});
	  }
	});
  });
*/

module.exports = router;

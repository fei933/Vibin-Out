const express = require('express'),
	router = express.Router(),
	mongoose = require('mongoose'),
	Playlist = mongoose.model('Playlist'),
	Song = mongoose.model('Song'),
	mongoose_fuzzy_searching = require('mongoose-fuzzy-searching'); // fuzzy search for deleting



// Spotify
var SpotifyWebApi = require('spotify-web-api-node');
const spotifyApi = new SpotifyWebApi({
	clientId: process.env.CLIENT_ID,
	clientSecret: process.env.CLIENT_SECRET
});

router.post('/create', (req, res) => {
	const {listSlug, title, artist} = req.body;
	spotifyApi.clientCredentialsGrant()
	.then(function(data) {
		spotifyApi.setAccessToken(data.body['access_token']);
		return spotifyApi.searchTracks(`track:${title} artist:${artist}`);
	})
	.then(function(data) {
		var song = data.body.tracks.items[0];
		if(song){
			// console.log(song);
			s = new Song({
				name: song.name,
				artists: song.artists.map(a => a['name']),
				album: song.album.name,
				cover: song.album.images.map(g => g['url'])[1],
				href: song.href,
				id: song.id,
				external_urls: song.external_urls.spotify,
				explicit : song.explicit,
				popularity: song.popularity,
			});
			s.save((err, song, count) => {
				if(err){
					console.log(err);
				}
			});
			Playlist.findOneAndUpdate({slug:listSlug}, {$push: {contents: [s]}}, (err) => {
				if(err){console.log(err);}
				res.redirect(`/list/${listSlug}`);
			});
		}else{
			console.log("Result not found");
			res.redirect(`/list/${listSlug}`);
		}
		
	})
	.catch(function(err) {
		console.log('Something went wrong:', err.message);
	});
	

});

// router.post('/check', (req, res) => {
// 	const {listSlug, items} = req.body;

// 	Playlist.findOne({slug:listSlug}, (err, list, count) => {
//     console.log(`items: ${items}, list: ${list}`);
// 		for (let i = 0; i < list.items.length; i++) {
//       		console.log(list.items[i]);
// 			if (items?.includes(list.items[i].name)) {
// 				list.items[i].checked = true;
// 			}
// 		}
// 		// list.markModified('items');
// 		list.save((err, savedPlaylist, count) => {
//       console.log(err);
// 			res.redirect(`/list/${listSlug}`);
// 		});
// 	});
// });

module.exports = router;

var SpotifyWebApi = require('spotify-web-api-node');
var spotifyAccessToken;

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET
});

// Get access token from Spotify, credential grant authorization method, no need to sign in
// this code snippet is revised from https://github.com/thelinmichael/spotify-web-api-node/blob/master/examples/client-credentials.js#L18
spotifyApi.clientCredentialsGrant().
    then(function(result) {
      spotifyAccessToken = result.body.access_token;
      console.log('current access token:' + result.body.access_token); 
    }).catch(function(err) {
      console.log(err);
});

exports.accessToken = spotifyAccessToken;
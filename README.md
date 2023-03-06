# Vibin' Out.

link to the deployed website: https://vibinout.herokuapp.com/ (the website is currently down, still in the process of re-deploying it)

## Overview

Loving your scent at home and want to play some music? Want to create and save song lists based on your favourite perfumes/candles? Vibin’ Out can be your #1 helper on that!

Vibin’Out is a web app that allow users to register and create personal music preference profile and publish playlists with scent(product) and mood labels. After registering and logging in, users will be able to:

1. Add personal bio, music preference tags, and personal information
2. Enhance their playlist based on songs that are already in the playlist, and
3. Create playlist based on product's scents and your preferred genres!

## Data Model

The application will store Users, Playlist, and Songs

playlist title, playlist id, and the id of the songs inside the playlist

- users can have multiple playlists (via references)
- each list have multiple songs inside them (by references as well)

An Example User:

```
{
  _id: new ObjectId("625f2671cc77a5f9866dff0f"),
  username: 'feifei',
  password: 'xxxxxxxx',
  favgenres: ['indie','mandopop'],
  playlists: [ObjectId("sdtjrytefdETWYREGd"),ObjectId("STHWUEGDFDhgeir")],
  __v: 0
}
```

An Example Playlist with Embedded Items:

```
{

_id: new ObjectId("626c18969c21ef2aa324d963"),
  name: 'Testing',
  product: new ObjectId("626c18969c21ef2aa324d951"),
  productname: 'Bibliothèque',
  username: 'feifei',
  user: new ObjectId("625f2671cc77a5f9866dff0f"),
  contents: [
    new ObjectId("626c18969c21ef2aa324d954"), // referring to tracks
    new ObjectId("626c18969c21ef2aa324d955"),
    new ObjectId("626c18969c21ef2aa324d956"),
    new ObjectId("626c18969c21ef2aa324d957"),
    new ObjectId("626c18969c21ef2aa324d958"),
    new ObjectId("626c18969c21ef2aa324d959"),
    new ObjectId("626c18969c21ef2aa324d95a")
  ],
  createdAt: 2022-04-29T16:55:50.934Z,
  slug: 'testing',
	name_fuzzy: Array,
	contents_fuzzy: Array
  __v: 0
}

``` 

An Example Song:

``` 
{
    _id: new ObjectId("626b4e874d0f42b3f004355d"),
    name: 'This is the Last Time',
    artists: [ 'The National' ],
    album: 'Trouble Will Find Me',
    href: 'https://api.spotify.com/v1/tracks/70ZuQywnmOpqcIiEnUA5yV',
    external_urls: 'https://open.spotify.com/track/70ZuQywnmOpqcIiEnUA5yV',
    id: '70ZuQywnmOpqcIiEnUA5yV',
    explicit: false,
    popularity: 54,
    cover: 'https://i.scdn.co/image/ab67616d00001e02a91e8d79776c6f83fa22ce72',
    __v: 0
}
```

## [Link to Commented First Draft Schema](/db.js)

## Wireframes

![documentation/Mainpage.png?raw=true](documentation/Mainpage.png?raw=true)

![documentation/RegistrationPage.png?raw=true](documentation/RegistrationPage.png?raw=true)

![documentation/PlaylistList.png?raw=true](documentation/PlaylistList.png?raw=true)

![documentation/ProductLibrary.png?raw=true](documentation/ProductLibrary.png?raw=true)

![documentation/PlaylistSlug.png?raw=true](documentation/PlaylistSlug.png?raw=true)

![documentation/UserProfile.png?raw=true](documentation/UserProfile.png?raw=true)



/list - page for showing all playlists users created

/list/create - page for creating a new shopping list

/list/:slug - individual presentation page for each playlist, contains the spotify plugin play button

/product-view - page that shows all products that have playlists associated with them

/profile - page for user profile and all playlists **the** user creates

/login - page for user login (or connect to Spotify account)

/register - page for creating account

## Site map

![documentation/sitemap.jpg?raw=true](documentation/sitemap.jpg?raw=true)

## User Stories or Use Cases

1. as non-registered user, I can register a new account with the site and log in to create playlists
2. as a user, I can create new playlist by adding songs one by one, or based on artist recommendations
3. as a user, I can view all of the playlists I've create in my profile
4. as a user, I can add songs to existing playlists or append additional songs by entering new seeds (track, artist, genre) for song recommendations
5. as a user, I can export the playlist by logging into spotify

## Module/Concept Research Topics

- (1 points) Intergrate user authentication
    - Use passport for authetication
- (4 points) Spotify API and https://github.com/thelinmichael/spotify-web-api-node
    - Spotify API not only allow one to have access to song informations in Spotify, it also has features like
        - recommendation and
        - creating playlists with songs (on spotify)
        - Spotify Play button (directly play songs on spotify)
    - Spotify also provide a lot of quantitative data of the song’s mood
- (2 points) iFrame API for Spotify song embedding
- (1 points) [Fuzzy search](https://www.npmjs.com/package/mongoose-fuzzy-searching) in mongoose for playlist search among playlists and products
- (1 point) Unsplash API for random default playlist cover
    - Unsplash is a free photo websites [https://unsplash.com/developers](https://unsplash.com/developers)
- (0.5-1 point) Google Fonts API


## Annotations / References Used

1. [passport.js authentication docs](http://passportjs.org/docs) - (add link to source code that was based on this)
2. [https://www.npmjs.com/package/mongoose-fuzzy-searching](https://www.npmjs.com/package/mongoose-fuzzy-searching) (mongoose fuzzy search)
3. Spotify Related Reference:
    1. [https://developer.spotify.com/documentation/web-api/reference/#/operations/get-audio-analysis](https://developer.spotify.com/documentation/web-api/reference/#/operations/get-audio-analysis) - Get audio track analysis (and many other Spotify API references)
    2. [https://developer.spotify.com/documentation/general/guides/authorization/client-credentials/](https://developer.spotify.com/documentation/general/guides/authorization/client-credentials/) Spotify Client Credential Flow Authorization
    3. [https://developer.spotify.com/documentation/web-api/reference/#/operations/get-recommendations](https://developer.spotify.com/documentation/web-api/reference/#/operations/get-recommendations) The most important feature that the entire web app based on, contains references on the query and response format of getting recommendations
    4. https://github.com/thelinmichael/spotify-web-api-node A Spotify API wrapper that includes features like providing recommendations, serach for tracks/artists, and search for genres.
    5. [https://developer.spotify.com/documentation/embeds/](https://developer.spotify.com/documentation/embeds/) spotify embeds for play
    6. [https://developer.spotify.com/documentation/embeds/guides/using-the-iframe-api/](https://developer.spotify.com/documentation/embeds/guides/using-the-iframe-api/) iframe-api
    7. [https://developer.spotify.com/community/showcase/dubolt/](https://developer.spotify.com/community/showcase/dubolt/) - a similar app that use Spotify API recormmendations feature to help users explore new music
4. [https://awik.io/generate-random-images-unsplash-without-using-api/](https://awik.io/generate-random-images-unsplash-without-using-api/) - potential way of using unsplash without using API

require('dotenv').config();
const mongoose = require('mongoose'),
	URLSlugs = require('mongoose-url-slugs'),
  passportLocalMongoose = require('passport-local-mongoose'),
  mongoose_fuzzy_searching = require('mongoose-fuzzy-searching');
  
const User = new mongoose.Schema({
  username: {type: String, required: true},
  password: {type: String, required: true},
  favgenres: [{type: String, required: false}],
  favscents: [{type: String, required: false}],
  playlists:[{ type: mongoose.Schema.Types.ObjectId,ref: 'Playlist',required: false}]
},{_id: true});

const Song = new mongoose.Schema({
	name: {type: String, required: true},
	artists: [{type: String, require: true}],
    album: {type: String, required: true},
    href: {type: String, required: false}, // from/for spotfy
    external_urls: {type: String, required: false}, // from spotify
    id: {type: String, required: false}, // from spotify
    explicit : {type: Boolean, required: false}, // from spotify
    popularity: {type: Number, required: false}, // from spotify
	cover: {type: String, required: false}
	
}, {_id: true});

const Product = new mongoose.Schema({
  name: {type: String, required: true},
  photo: {type: String, required:false},
  category: {type:String, required: true},
  brand: {type: String, required: false},
  scent: [{type: String, required: false}],
  description: {type: String, required: false}
},{_id: true});

const Playlist = new mongoose.Schema({
  name: {type: String, required: true},
  product: {type: mongoose.Schema.Types.ObjectId, ref:'Product'},
  productname:{type: String, required: true},
  username: {type: String},
  user: {type: mongoose.Schema.Types.ObjectId, ref:'User'},
  cover: {type: String, required: false},
  contents: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Song' }],
  createdAt: {type: Date, required: true}
},{_id: true});


User.plugin(passportLocalMongoose);
Playlist.plugin(URLSlugs('name'));
Playlist.plugin(mongoose_fuzzy_searching, { 
  fields: [
    {
      name:'name',
      minSize: 2,
      weight: 5,
    },
    {
      name:'contents',
      keys:['name'],
    }
  ] 
});
Song.plugin(mongoose_fuzzy_searching, {fields:
  [
    {
      name:"name",
      minSize: 2,
      weight: 1,
    },
    {
      name:"artists",
    }
]
});


mongoose.model('User', User,'User');
mongoose.model('Product', Product, 'Product');
mongoose.model('Playlist', Playlist, 'Playlist');
mongoose.model('Song', Song, 'Song');
// mongoose.connect('mongodb://localhost/playlistdb');

mongoose.connect(process.env.MONGODB_URI, (err) => {
  if (err) {
    console.log(err);
  } else {
    console.log('connected to database'); 
  }
});
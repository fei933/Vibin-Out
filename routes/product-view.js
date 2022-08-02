const express = require('express'),
	router = express.Router(),
	mongoose = require('mongoose'),
	mongoose_fuzzy_searching = require('mongoose-fuzzy-searching'),
	Product = mongoose.model('Product');

router.get('/', (req, res) => {
	Product.find({}, (err, allpr, count) => {
		res.render('product-view.hbs', {pr:allpr});
	});
});


router.post('/', (req, res) => {
    console.log('body:',req.body);
	const n = req.body.name;
	const c  = req.body.category;
	const b = req.body.brand;
	const d = req.body.descrip;
	// const sc = req.body.scents;
	const p = new Product({
        name: n.toLowerCase(),
        category: c,
        brand: b,
        description: d
	});
	Product.findOne({name:n.toLowerCase(), category:c}, function(err, result) {
		console.log(result);
		if(!result){
			p.save((err)=>{if(err) console.log(err);});
		}else{
			p = result;
		}
	});
    console.log(p);
    p.save((err, savedprod) => {
		if(err){
			console.log('Error Occur');
		}
		res.redirect('/product-view');
	});
});


module.exports = router;

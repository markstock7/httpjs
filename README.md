var http = require('httpjs');

http.init({
  endpoing: 'http://localhost:3000'
});


http.get('post')
  .then(posts => {

  });
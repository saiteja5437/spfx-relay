var newsItems = ['Alpha ships', 'Beta lands'];
document.getElementById('news-refresh').addEventListener('click', function () {
  var list = document.getElementById('news-list');
  list.innerHTML = newsItems.join(', ');
});

$(document).ready(function () {
  var clicks = 0;
  $('#ticker-go').click(function () {
    clicks += 1;
    $('#ticker-value').text(String(clicks));
  });
});

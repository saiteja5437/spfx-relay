var count = 0;

$('#increment-button').click(function () {
  count = count + 1;
  $('#count-value').text(count);
});

function resetCounter() {
  count = 0;
  $('#count-value').text('0');
}

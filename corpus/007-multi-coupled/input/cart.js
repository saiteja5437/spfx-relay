var cartTotal = 0;
$('#add-item').click(function () {
  cartTotal += 1;
});
$('#cart-refresh').click(function () {
  $('#cart-count').text(String(cartTotal));
});

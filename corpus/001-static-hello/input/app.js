var button = document.getElementById('load-button');

button.addEventListener('click', function () {
  var output = document.getElementById('greeting-output');
  output.textContent = 'Hello from the legacy web part!';
});

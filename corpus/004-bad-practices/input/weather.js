var apiKey = 'wx-secret-12345';
var output = document.getElementById('weather-output');

fetch('https://weather.example.com/api/current?key=' + apiKey)
  .then(function (response) { return response.json(); })
  .then(function (data) {
    output.textContent = data.summary;
  });

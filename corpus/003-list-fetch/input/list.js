$('#refresh-button').click(function () {
  $('#status-line').text('Loading...');
  $.ajax({
    url: "/_api/web/lists/getbytitle('Tasks')/items",
    method: 'GET',
    headers: { Accept: 'application/json;odata=verbose' },
    success: function (data) {
      renderTasks(data.d.results);
    }
  });
});

function renderTasks(items) {
  $('#tasks-list').empty();
  for (var i = 0; i < items.length; i++) {
    $('#tasks-list').append('<li>' + items[i].Title + '</li>');
  }
  $('#status-line').text('Loaded ' + items.length + ' tasks');
}

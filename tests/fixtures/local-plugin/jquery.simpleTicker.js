(function ($) {
  $.fn.simpleTicker = function (options) {
    var settings = $.extend({ interval: 3000 }, options);
    return this.each(function () {
      var list = $(this);
      setInterval(function () {
        list.find('li:first').appendTo(list);
      }, settings.interval);
    });
  };
})(jQuery);

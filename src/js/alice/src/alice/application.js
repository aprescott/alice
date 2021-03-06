Alice.Application = Class.create({
  initialize: function() {
    this.options = {};
    this.isFocused = true;
    this.window_map = new Hash();
    this.previousFocus = 0;
    this.selectedSet = '';
    this.tabs = $('tabs');
    this.topic = $('topic');
    this.nicklist = $('nicklist');
    this.overlayVisible = false;
    this.lastnotify = 0;
    this.topic_height = "14px";
    this.connection = window.WebSocket ? new Alice.Connection.WebSocket(this) : new Alice.Connection.XHR(this);

    this.tabs_width = $('tabs_container').getWidth();
    this.tabs_layout = this.tabs.getLayout();

    this.base_filters = this.baseFilters();
    this.message_filters = [];

    this.supportsTouch = 'createTouch' in document;

    this.isPhone = window.navigator.userAgent.match(/(android|iphone)/i) ? true : false;
    this.isMobile = this.isPhone || Prototype.Browser.MobileSafari;
    this.loadDelay = this.isMobile ? 3000 : 1000;
    if (window.navigator.standalone || window.navigator.userAgent.match(/Fluid/)) this.loadDelay = 0;
    
    this.keyboard = new Alice.Keyboard(this);

    this.input = new Alice.Input(this, "msg");
    this.submit = $("submit");

    this.submit.observe("click", function (e) {
        this.input.send(); e.stop()}.bind(this));

    this.tabs.observe("webkitTransitionEnd", this.shiftEnd.bind(this));
    this.tabs.observe("transitionend", this.shiftEnd.bind(this));

    // setup UI elements in initial state
    this.makeSortable();
    this.setupTopic();
    this.setupNicklist();
    this.setupMenus();
    
    this.oembeds = [
      /https?:\/\/.*\.flickr.com\/.*/i,
      /https?:\/\/www\.youtube\.com\/watch.*/i,
      /https?:\/\/.*\.wikipedia.org\/wiki\/.*/i,
      /https?:\/\/.*\.twitpic\.com\/.*/i,
      /https?:\/\/www\.hulu\.com\/watch\/.*/i,
      /https?:\/\/(:?www\.)?vimeo\.com\/.*/i,
      /https?:\/\/(:?www\.)?vimeo\.com\/groups\/.*\/videos\/.*/i,
      /https?:\/\/.*\.funnyordie\.com\/videos\/.*/i,
      /https?:\/\/gist\.github\.com\/[0-9a-fA-F]+/i,
      /https?:\/\/(?:www\.)?twitter\.com\/(?:#!\/)?[^\/]+\/status(?:es)?\/\d+/i,
    ];
    this.jsonp_callbacks = {};
  },

  addOembedCallback: function(id, win) {
    this.jsonp_callbacks[id] = function (data) {
      delete this.jsonp_callbacks[id];
      if (!data || !data.html) return;

      var a = $(id);
      a.update(data.title);
      a.insert({
        after: ' on <a class="external" href="'+data.provider_url+'">'
               +data.provider_name+'</a><div class="oembed"></div>'
      });
      var html = data.html;

      a.observe('click', function(e) {
        e.stop();
        var scroll = win.shouldScrollToBottom();
        var div = a.next(".oembed");
        if (div.innerHTML) {
          div.innerHTML = "";
          return;
        }
        div.innerHTML = html;
        setTimeout(function(){
          div.style.display = "block";
          if (scroll) win.scrollToBottom(true);
        }, 10);
      });
    }.bind(this);
    return "alice.jsonp_callbacks."+id;
  },

  actionHandlers: {
    join: function (action) {
      var win = this.getWindow(action['window'].id);
      if (!win) {
        this.insertWindow(action['window'].id, action.html);
        win = this.openWindow(action['window']);
        this.updateOverflowMenus();
        if (this.selectedSet && !this.currentSetContains(win)) {
          if (confirm("You joined "+win.title+" which is not in the '"+this.selectedSet+"' set. Do you want to add it?")) {
            this.tabsets[this.selectedSet].push(win.id);
            win.show();
            Alice.tabsets.submit(this.tabsets);
          }
          else {
            win.hide();
          }
        }
      }
      win.updateNicks(action.nicks);
    },
    part: function (action) {
      this.closeWindow(action['window'].id);
    },
    nicks: function (action) {
      var win = this.getWindow(action['window'].id);
      if (win) win.updateNicks(action.nicks);
    },
    alert: function (action) {
      this.activeWindow().showAlert(action['body']);
    },
    clear: function (action) {
      var win = this.getWindow(action['window'].id);
      if (win) {
        win.messages.update("");
        win.lastNick = "";
      }
    },
    announce: function (action) {
      this.activeWindow().announce(action['body']);
    },
    connect: function (action) {
      action.windows.each(function (win_info) {
        var win = this.getWindow(win_info.id);
        if (win) {
          win.enable();
        }
      }.bind(this));
      if ($('servers')) {
        Alice.connections.connectServer(action.session);
      }
    },
    disconnect: function (action) {
      action.windows.each(function (win_info) {
        var win = this.getWindow(win_info.id);
        if (win) {
          win.disable();
        }
      }.bind(this));
      if ($('servers')) {
        Alice.connections.disconnectServer(action.session);
      }
    },
    focus: function (action) {
      if (!action.window_number) return;
      if (action.window_number == "next") {
        this.nextWindow();
      }
      else if (action.window_number.match(/^prev/)) {
        this.previousWindow();
      }
      else if (action.window_number.match(/^\d+$/)) {
        var tab = this.tabs.down('li', action.window_number);
        if (tab) {
          var window_id = tab.id.replace('_tab','');
          this.getWindow(window_id).focus();
        }
      }
    }
  },
  
  toggleHelp: function() {
    var help = $('help');
    help.visible() ? help.hide() : help.show();
  },

  toggleConfig: function(e) {
    this.connection.getConfig(function (transport) {
      this.input.disabled = true;
      $('windows').insert(transport.responseText);
    }.bind(this));
    
    if (e) e.stop();
  },
  
  togglePrefs: function(e) {
    this.connection.getPrefs(function (transport) {
      this.input.disabled = true;
      $('windows').insert(transport.responseText);
    }.bind(this));
    
    if (e) e.stop();
  },

  toggleTabsets: function(e) {
    this.connection.getTabsets(function (transport) {
      this.input.disabled = true;
      $('windows').insert(transport.responseText);
      Alice.tabsets.focusIndex(0);
    }.bind(this));
  },

  windows: function () {
    return this.window_map.values();
  },

  nth_window: function(n) {
    var tab = this.tabs.down('.visible:not(.info_tab)', n - 1);
    if (tab) {
      var m = tab.id.match(/([^_]+)_tab/);
      if (m) {
        return this.window_map.get(m[1]);
      }
    }
  },

  info_window: function(n) {
    return this.windows().find(function(win) {
      if (win.type == "info") return win;
    });
  },
  
  openWindow: function(serialized) {
    var win = new Alice.Window(this, serialized);
    this.addWindow(win);
    return win;
  },
  
  addWindow: function(win) {
    this.window_map.set(win.id, win);
    if (window.fluid)
      window.fluid.addDockMenuItem(win.title, win.focus.bind(win));
  },
  
  removeWindow: function(win) {
    this.tabs_layout = this.tabs.getLayout();

    this.windows().invoke("updateTabLayout");

    if (win.active) this.focusLast();
    if (window.fluid)
      window.fluid.removeDockMenuItem(win.title);
    if (win.id == this.previousFocus.id) {
      this.previousFocus = 0;
    }
    this.window_map.unset(win.id);
    this.connection.closeWindow(win);
    win = null;
  },
  
  getWindow: function(windowId) {
    return this.window_map.get(windowId);
  },
  
  activeWindow: function() {
    var windows = this.windows();
    for (var i=0; i < windows.length; i++) {
      if (windows[i].active) return windows[i];
    }
    for (var i=0; i < windows.length; i++) {
      if (windows[i].type != "info") return windows[i];
    }
    if (windows[0]) return windows[0];
  },
  
  addFilters: function(list) {
    this.message_filters = this.message_filters.concat(list);
  },
  
  applyFilters: function(li, win) {
    if (li.hasClassName("filtered")) return;

    this.base_filters.each(function(f) {
      try { f.call(this, li, win); }
      catch (e) { this.log(e.toString()) }
    }.bind(this));

    // skip all the extra filters on phones
    if (!this.isPhone) {
      if (li.hasClassName("message")) {
        var msg = li.down("div.msg");
        this.message_filters.each(function(f){
          try { f.call(this, msg, win); }
          catch (e) { this.log(e.toString()) }
        }.bind(this));
      }
    }

    li.addClassName("filtered");
  },
  
  nextWindow: function() {
    var active = this.activeWindow();

    var nextTab = active.tab.next('.visible');
    if (!nextTab) nextTab = this.tabs.down('.visible');
    if (!nextTab) return;

    var id = nextTab.id.replace('_tab','');
    if (id != active.id) {
      var win = this.getWindow(id);
      win.focus();
      return win;
    }
  },

  updateOverflowMenus: function() {
    var left = $('tab_menu_left');
    var right = $('tab_menu_right');

    left.removeClassName("unread");
    left.removeClassName("highlight");
    right.removeClassName("unread");
    right.removeClassName("highlight");

    var left_menu = left.down('ul');
    var right_menu = right.down('ul');

    left_menu.innerHTML = "";
    right_menu.innerHTML = "";

    this.windows().each(function(win) {

      if (!win.visible) return;

      var pos = win.getTabPosition();

      if (pos.left) {
        var classes = win.status_class();
        left.addClassName(classes);
        left_menu.innerHTML += sprintf('<li rel="%s" class="%s">%s</a>', win.id, classes, win.title)
      }
      else if (pos.right) {
        var classes = win.status_class();
        right.addClassName(classes);
        right_menu.innerHTML += sprintf('<li rel="%s" class="%s">%s</a>', win.id, classes, win.title)
      }

    }.bind(this));

    this.toggleMenu(left, !!left_menu.innerHTML);
    this.toggleMenu(right, !!right_menu.innerHTML);
  },

  toggleMenu: function(menu, active) {
    if (active) {
      menu.addClassName("active");
    }
    else {
      menu.removeClassName("active");
    }
  },

  nextUnreadWindow: function() {
    var active = this.activeWindow();
    var tabs = active.tab.nextSiblings().concat(active.tab.previousSiblings().reverse());
    var unread = tabs.find(function(tab) {
      return tab.hasClassName("unread") && tab.hasClassName("visible")
    });

    if (unread) {
      var id = unread.id.replace("_tab","");
      if (id) {
        this.getWindow(id).focus();
      }
    }
  },
  
  focusLast: function() {
    if (this.previousFocus && this.previousFocus.id != this.activeWindow().id)
      this.previousFocus.focus();
    else
      this.previousWindow();
  },
  
  previousWindow: function() {
    var active = this.activeWindow();

    var previousTab = this.activeWindow().tab.previous('.visible');
    if (!previousTab) previousTab = this.tabs.select('.visible').last();
    if (!previousTab) return;

    var id = previousTab.id.replace('_tab','');
    if (id != active.id) this.getWindow(id).focus();
  },
  
  closeWindow: function(windowId) {
    var win = this.getWindow(windowId);
    if (win) win.close();
  },
  
  insertWindow: function(windowId, html) {
    if (!$(windowId)) {
      $('windows').insert(html['window']);
      $('tabs').insert(html.tab);
      this.makeSortable();
    }
  },
  
  highlightChannelSelect: function(id, classname) {
    if (!classname) classname = "unread";
    ['tab_menu_left', 'tab_menu_right'].find(function(menu) {
      menu = $(menu);

      var li = menu.down('li[rel='+id+']');
      if (li) {
        li.addClassName(classname);
        menu.addClassName(classname);
        return true;
      }
      return false;
    });
  },
  
  unHighlightChannelSelect: function(id) {
    ['tab_menu_left', 'tab_menu_right'].find(function(menu) {
      menu = $(menu);

      var li = menu.down('li[rel='+id+']');
      if (li) {
        li.removeClassName("unread");
        li.removeClassName("highlight");
        ["unread", "highlight"].each(function(c) {
          if (!menu.select('li').any(function(li) {return li.hasClassName(c)})) {
            menu.removeClassName(c);
          }
        });
        return true;
      }
      return false;
    });
  },
  
  handleAction: function(action) {
    if (this.actionHandlers[action.event]) {
      this.actionHandlers[action.event].call(this,action);
    }
  },
  
  displayMessage: function(message) {
    var win = this.getWindow(message['window'].id);
    if (win) {
      win.addMessage(message);
    } else {
      this.connection.requestWindow(
        message['window'].title, message['window'].id, message
      );
    }
  },

  displayChunk: function(message) {
    var win = this.getWindow(message['window'].id);
    if (win) {
      win.addChunk(message);
    }
  },

  focusHash: function(hash) {
    if (!hash) hash = window.location.hash;
    if (hash) {
      hash = decodeURI(hash);
      hash = hash.replace(/^#/, "");

      if (hash.substr(0,1) != "/") {
        var name = hash.match(/^([^\/]+)/)[0];
        hash = hash.substr(name.length);
        if (this.tabsets[name]) {
          if (this.selectedSet != name) this.showSet(name);
        }
        else {
          window.location.hash = hash;
          window.location = window.location.toString();
          return false;
        }
      }

      var windows = this.windows();
      for (var i = 0; i < windows.length; i++) {
        var win = windows[i];
        if (win.hashtag == hash) {
          if (!win.active) win.focus();
          return true;
        }
      }
    }
    return false;
  },

  tabShift: function() {
    return this.tabs_layout.get('left');
  },

  tabsWidth: function() {
    return this.tabs_width;
  },

  freeze: function() {
    $('windows').setStyle({
      width: document.viewport.getWidth()+"px",
      right: "auto",
    });
  },

  thaw: function() {
    $('windows').setStyle({
      width: "auto",
      right: "0px",
    });
  },

  shiftTabs: function(shift) {
    var current = this.tabShift();

    var left = current + shift;
    var time = Math.min(Math.max(0.1, Math.abs(shift) / 100), 0.5);

    this.tabs.style.webkitTransitionDuration = time+"s";
    this.tabs.setStyle({left: left+"px"});
    this.tabs_layout = this.tabs.getLayout();
  },
  
  shiftEnd: function(e) {
    this.tabs_layout = this.tabs.getLayout();
    this.updateOverflowMenus();
  },
  
  makeSortable: function() {
    Sortable.create('tabs', {
      overlap: 'horizontal',
      constraint: 'horizontal',
      format: /(.+)/,
      onUpdate: function (res) {
        var tabs = res.childElements();
        var order = tabs.collect(function(t){
          var m = t.id.match(/([^_]+)_tab/);
          if (m) return m[1]
        });
        if (order.length) this.connection.sendTabOrder(order);

        // do this in a timeout because we need to wait for the tab
        // to slide into its new position
        setTimeout(function(){
          this.windows().invoke("updateTabLayout");
          this.activeWindow().shiftTab();
        }.bind(this), 100);
      }.bind(this)
    });
  },

  addMissed: function() {
    if (!window.fluid) return;
    window.fluid.dockBadge ? window.fluid.dockBadge++ :
                             window.fluid.dockBadge = 1;
  },

  clearMissed: function() {
    if (!window.fluid) return;
    window.fluid.dockBadge = "";
  },

  ready: function() {
    this.connection.connect();

    // required due to browser weirdness with scrolltobottom on initial focus
    setTimeout(function(){
      this.focusHash() || this.activeWindow().focus();
      this.activeWindow().scrollToBottom(true)
      this.freeze();
      setTimeout(this.updateOverflowMenus.bind(this), 1000);
    }.bind(this), 10);
  },

  log: function () {
    var win = this.activeWindow();
    for (var i=0; i < arguments.length; i++) {
      if (window.console && window.console.log) {
        console.log(arguments[i]);
      }
      if (this.options.debug == "true") {
        if (win) {
          win.addMessage({
            html: '<li class="message monospace"><div class="left">console</div><div class="msg">'+arguments[i].toString()+'</div></li>'
          });
        }
      }
    }
  },

  msgid: function() {
    var ids = this.windows().map(function(w){return w.msgid});
    return Math.max.apply(Math, ids);
  },

  setSource: function(id) {
    $('source').value = id;
  },

  showSet: function(name) {
    var ids = this.tabsets[name];
    if (ids) {
      var elem = $('tabset_menu').select('li').find(function(li) {
        return li.innerHTML.unescapeHTML() == name;
      });
      elem.up('ul').select('li').invoke('removeClassName', 'selectedset');
      elem.addClassName('selectedset');

      this.windows().each(function(win) {
        ids.indexOf(win.id) >= 0 || win.type == "privmsg" ? win.show() : win.hide();
      });

      this.selectSet(name);

      var active = this.activeWindow();

      if (!active.visible) {
        active = this.nextWindow();
      }

      if (active) active.shiftTab();
      setTimeout(this.updateOverflowMenus.bind(this), 2000);
    }
  },

  selectSet: function(name) {
    var hash = window.location.hash;
    hash = hash.replace(/^[^\/]*/, name);
    window.location.hash = hash;
    window.location = window.location.toString();
    this.selectedSet = name;
  },

  clearSet: function(elem) {
    elem.up('ul').select('li').invoke('removeClassName', 'selectedset');
    elem.addClassName('selectedset');
    this.windows().invoke("show");
    this.selectSet('');
    this.updateOverflowMenus();
    this.activeWindow().shiftTab();
  },

  currentSetContains: function(win) {
    var set = this.selectedSet;
    if (win.type == "channel" && set && this.tabsets[set]) {
      return (this.tabsets[set].indexOf(win.id) >= 0);
    }
    return true;
  },

  displayTopic: function(new_topic) {
    this.topic.update(new_topic || "no topic set");
    Alice.makeLinksClickable(this.topic);
  },

  displayNicks: function(nicks) {
    this.nicklist.innerHTML = nicks.sort(function(a, b) {
      a = a.toLowerCase();
      b = b.toLowerCase();
      if (a > b) 
        return 1 
      if (a < b) 
        return -1 
      return 0;
    }).map(function(nick) {
      return '<li><a>'+nick.escapeHTML()+'</a></li>';
    }).join("");
  },

  toggleNicklist: function() {
    var windows = $('windows');
    var win = this.activeWindow();
    var scroll = win.shouldScrollToBottom();
    if (windows.hasClassName('nicklist'))
      windows.removeClassName('nicklist');
    else
      windows.addClassName('nicklist');
    if (scroll) win.scrollToBottom(true);
  },

  setupNicklist: function() {
    this.nicklist.observe("click", function(e) {
      var li = e.findElement('a');
      if (li) {
        var nick = a.innerHTML;
        this.connection.requestWindow(nick, this.activeWindow().id);
      }
    }.bind(this));
  },

  setupTopic: function() {
    this.topic.observe(this.supportsTouch ? "touchstart" : "click", function(e) {
      if (this.supportsTouch) e.stop();
      if (this.topic.getStyle("height") == this.topic_height) {
        this.topic.setStyle({height: "auto"});
      } else {
        this.topic.setStyle({height: this.topic_height});
      }
    }.bind(this));
  },

  setupMenus: function() {
    var click = this.supportsTouch ? "touchend" : "mouseup";

    $('config_menu').observe(click, function(e) {
      var li = e.findElement(".dropdown li");
      if (li) {
        e.stop();
        switch(li.innerHTML) {
          case "Help":
            this.toggleHelp();
            break;
          case "Preferences":
            this.togglePrefs();
            break;
          case "Connections":
            this.toggleConfig();
            break;
          case "Logout":
            window.location = "/logout";
            break;
        }
        $$('.dropdown.open').invoke("removeClassName", "open");
      }
    }.bind(this));

    $('tabset_menu').observe(click, function(e) {
      var li = e.findElement(".dropdown li");
      if (li) {
        e.stop();
        var name = li.innerHTML.unescapeHTML();

        if (name == "Edit Sets")
          this.toggleTabsets();
        else if (name == "All tabs")
          this.clearSet(li);
        else if (this.tabsets[name])
          this.showSet(name);

        $$('.dropdown.open').invoke("removeClassName", "open");
      }
    }.bind(this));

    ['tab_menu_left', 'tab_menu_right'].each(function(side) {
      $(side).observe(click, function(e) {
        var li = e.findElement(".dropdown li");
        if (!li) return;

        if (li && li.getAttribute("rel")) {
          $(side).removeClassName("open");
          var win = this.getWindow(li.getAttribute("rel"));
          if (win) win.focus();
        }
      }.bind(this));
    }.bind(this));
  },

  baseFilters: function() {
    return [
      // linkify
      function(li, win) {
        Alice.makeLinksClickable(li.down("div.msg"));
      },

      // insert avatars
      function(li, win) {
        if (li.hasClassName("avatar")) {
          if (this.options.avatars == "show") {
            var avatar = li.getAttribute("avatar");
            if (avatar)
              li.down("a.nick").insert('<img src="'+alice.options.image_prefix+avatar+'" />');
          }
          else {
            li.removeClassName("avatar");
          }
        }
      },

      // shrink previous line for consecutive messages
      function(li, win) {
        if (li.hasClassName("consecutive")) {
          var prev = li.previous(); 
          if (!prev) return;

          if (prev && prev.hasClassName("avatar") && !prev.hasClassName("consecutive"))
            prev.down('div.msg').setStyle({minHeight: '0px'});
          if (prev && prev.hasClassName("monospaced"))
            prev.down('div.msg').setStyle({paddingBottom: '0px'});
        }
      },

      // toggle on timestamps if it has been 5 minutes
      function(li, win) {
        var stamp = li.down('.timestamp');
        if (!stamp) return;

        var remove = false;
        var seconds = stamp.innerHTML.strip();

        if (li.hasClassName("message")) {
          var time = new Date(seconds * 1000);
          var diff = (time - win.lasttimestamp) / 1000;
          remove = !(diff >= 300 || (diff > 60 && time.getMinutes() % 5 == 0));
          if (!remove) win.lasttimestamp = time;
        }

        if (remove) {
          stamp.remove();
        }
        else {
          stamp.update(Alice.epochToLocal(seconds, this.options.timeformat));
          stamp.style.opacity = 1;
        }
      },

      // turn on nicks if they are toggled
      function(li, win) {
        if (!this.overlayVisible || !li.hasClassName("avatar")) return;

        var nick = li.down('span.nick');
        if (nick) nick.style.opacity = 1;
      },

      // highlights
      function(li, win) {
        if (win.bulk_insert) return;

        if (li.hasClassName("message") && !win.active && win.title != "info") {
          if (li.hasClassName("highlight") || win.type == "privmsg")
            win.markUnread("highlight");
          else if (!li.hasClassName("self"))
            win.markUnread();
        }
      },

      // growls
      function(li, win) {
        if (this.isFocused || win.bulk_insert || li.hasClassName("self")) return;

        if (li.hasClassName("highlight") || win.type == "privmsg") {
          var prefix = "";

          if (win.type != "privmsg")
            prefix = li.down("span.nick").innerHTML.stripTags().unescapeHTML() + " in ";

          var message = {
            body: li.down(".msg").innerHTML.stripTags().unescapeHTML(),
            subject: prefix + win.title.stripTags().unescapeHTML()
          };

          var time = (new Date()).getTime();
          if (time - this.lastnotify > 5000) {
            this.lastnotify = time;
            Alice.growlNotify(message);
          }
          this.addMissed();
        }
      }

    ];
  },

  toggleOverlay: function () {
    this.overlayVisible = !this.overlayVisible;
    var opacity = this.overlayVisible ? 1 : 0;

    $$("li.avatar span.nick").each(function(span){
      span.style.opacity = opacity;
    });
  }

});

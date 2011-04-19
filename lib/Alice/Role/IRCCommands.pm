package Alice::Role::IRCCommands;

use Any::Moose 'Role';

use List::MoreUtils qw/none/;
use Try::Tiny;
use Class::Throwable qw/NetworkRequired InvalidNetwork ChannelRequired InvalidArguments/;

our %COMMANDS;
my $SRVOPT = qr/\-(\S+)\s*/;

sub commands {
  return grep {$_->{eg}} values %COMMANDS;
}

sub irc_command {
  my ($self, $window, $line) = @_;
  try {
    my ($command, $args) = $self->match_irc_command($line);
    $self->run_irc_command($window, $command, $args);
  }
  catch {
    $self->send_announcement($window, $_->getMessage);
  }
}

sub match_irc_command {
  my ($self, $line) = @_;

  $line = "/say $line" unless substr($line, 0, 1) eq "/";

  for my $name (keys %COMMANDS) {

    if ($line =~ m{^/$name\b\s*(.*)}) {
      my $args = $1;
      return ($name, $args);
    }
  }
}

sub run_irc_command {
  my ($self, $window, $name, $args) = @_;
  my $command = $COMMANDS{$name};

  my $req = {window => $window};

  # must be in a channel
  if ($command->{window_type} and none {$_ eq $window->type} @{$command->{window_type}}) {
    my $types = join " or ", @{$command->{window_type}};
    throw ChannelRequired "Must be in a $types for /$command->{name}.";
  }

  # determine the connection if it is required
  if ($command->{connection}) {
    my $network = $window->network;
    if ($args =~ s/^$SRVOPT//) {
      $network = $1;
    }

    throw NetworkRequired "Must specify a network for /$command->{name}"
      unless $network; 

    my $connection = $self->get_connection($network);

    throw InvalidNetwork "The $network network does not exist."
      unless $connection;

    throw InvalidNetwork "The $network network is not connected"
      unless $connection->is_connected;

    $req->{connection} = $connection;
  }

  # gather any options
  if (my $opt_re = $command->{opts}) {
    if (my (@opts) = ($args =~ /$opt_re/)) {
      $req->{opts} = \@opts;
    }
    else {
      throw InvalidArguments "Invalid arguments for /$command->{name}";
    }
  }

  $command->{cb}->($self, $req);
}

sub command {
  my ($name, $opts) = @_;
  $COMMANDS{$name} = $opts;
}

command say => {
  name => "say",
  window_type => [qw/channel privmsg/],
  connection => 1,
  opts => qr{(.*)},
  cb => sub {
    my ($self, $req) = @_;

    my $msg = $req->{opts}[0];
    my $window = $req->{window};
    my $connection = $req->{connection};

    $self->send_message($window, $connection->nick, $msg);
    $connection->send_long_line(PRIVMSG => $window->title, $msg);
  },
};

command msg => {
  name => "msg",
  opts => qr{(\S+)\s*(.*)},
  desc => "Sends a message to a nick.",
  connection => 1,
  cb => sub  {
    my ($self, $req) = @_;

    my ($nick, $msg) = @{ $req->{opts} };

    my $new_window = $self->find_or_create_window($nick, $req->{connection});
    $self->broadcast($new_window->join_action);

    if ($msg) {
      my $connection = $req->{connection};
      $self->send_message($new_window, $connection->nick, $msg);
      $connection->send_srv(PRIVMSG => $nick, $msg);
    }
  }
};

command nick => {
  name => "nick",
  opts => qr{(\S+)},
  connection => 1,
  eg => "/NICK [-<server name>] <new nick>",
  desc => "Changes your nick.",
  cb => sub {
    my ($self, $req) = @_;

    my $nick = $req->{opts}[0];
    $req->{connection}->log(info => "now known as $nick");
    $req->{connection}->send_srv(NICK => $nick);
  }
};

command qr{names|n} => {
  name => "names",
  window_type => [qw/channel privmsg/],
  eg => "/NAMES [-avatars]",
  desc => "Lists nicks in current channel.",
  cb => sub  {
    my ($self, $req) = @_;
    my $window = $req->{window};
    $self->send_announcement($window, $window->nick_table);
  },
};

command qr{join|j} => {
  name => "join",
  opts => qr{(\S+)\s*(\S+)?},
  connection => 1,
  eg => "/JOIN [-<server name>] <channel> [<password>]",
  desc => "Joins the specified channel.",
  cb => sub  {
    my ($self, $req) = @_;

    $self->log(info => "joining ".$req->{opts}[0]);
    $req->{connection}->send_srv(JOIN => @{$req->{opts}});
  },
};

command create => {
  name => "create",
  opts => qr{(\S+)},
  connection => 1,
  cb => sub  {
    my ($self, $req) = @_;

    my $name = $req->{opts}[0];

    my $new_window = $self->find_or_create_window($name, $req->{connection});
    $self->broadcast($new_window->join_action);
  }
};

command qr{close|wc|part} => {
  name => 'part',
  window_type => [qw/channel privmsg/],
  eg => "/PART",
  desc => "Leaves and closes the focused window.",
  cb => sub  {
    my ($self, $req) = @_;

    my $window = $req->{window};
    $self->close_window($window);

    if ($window->is_channel) {
      my $connection = $self->get_connection($window->network);
      $connection->send_srv(PART => $window->title) if $connection->is_connected;
    }
  },
};

command clear =>  {
  name => 'clear',
  eg => "/CLEAR",
  desc => "Clears lines from current window.",
  cb => sub {
    my ($self, $req) = @_;
    $req->{window}->clear;
    $self->broadcast($req->{window}->clear_action);
  },
};

command qr{topic|t} => {
  name => 'topic',
  opts => qr{(.+)?},
  window_type => ['channel'],
  connection => 1,
  eg => "/TOPIC [<topic>]",
  desc => "Shows and/or changes the topic of the current channel.",
  cb => sub  {
    my ($self, $req) = @_;

    my $new_topic = $req->{opts}[0];
    my $window = $req->{window};

    if ($new_topic) {
      my $connection = $req->{connection};
      $window->topic({string => $new_topic, nick => $connection->nick, time => time});
      $connection->send_srv(TOPIC => $window->title, $new_topic);
    }
    else {
      my $topic = $window->topic;
      $self->send_event($window, "topic", $topic->{author}, $topic->{string});
    }
  }
};

command whois =>  {
  name => 'whois',
  connection => 1,
  opts => qr{(\S+)},
  eg => "/WHOIS [-<server name>] <nick>",
  desc => "Shows info about the specified nick",
  cb => sub  {
    my ($self, $req) = @_;

    my $nick = $req->{opts}[0];
    $req->{connection}->add_whois($nick);
  },
};

command me =>  {
  name => 'me',
  opts => qr{(.+)},
  eg => "/ME <message>",
  window_type => [qw/channel privmsg/],
  connection => 1,
  desc => "Sends a CTCP ACTION to the current window.",
  cb => sub {
    my ($self, $req) = @_;
    my $action = $req->{opts}[0];

    my $window = $req->{window};
    my $connection = $req->{connection};

    $self->send_message($window, $connection->nick, "\x{2022} $action");
    $action = AnyEvent::IRC::Util::encode_ctcp(["ACTION", $action]);
    $connection->send_srv(PRIVMSG => $window->title, $action);
  },
};

command quote => {
  name => 'quote',
  opts => qr{(.+)},
  connection => 1,
  eg => "/QUOTE [-<server name>] <data>",
  desc => "Sends the server raw data without parsing.",
  cb => sub  {
    my ($self, $req) = @_;

    my $command = $req->{opts}[0];
    $req->{connection}->send_raw($command);
  },
};

command disconnect => {
  name => 'disconnect',
  opts => qr{(\S+)},
  eg => "/DISCONNECT <server name>",
  desc => "Disconnects from the specified server.",
  cb => sub  {
    my ($self, $req) = @_;

    my $network = $req->{opts}[0];
    my $connection = $self->get_connection($network);
    my $window = $req->{window};

    if ($connection) {
      if ($connection->is_connected) {
        $connection->disconnect;
      }
      elsif ($connection->reconnect_timer) {
        $connection->cancel_reconnect;
        $connection->log(info => "Canceled reconnect timer");
      }
      else {
        $self->send_announcement($window, "Already disconnected");
      }
    }
    else {
      $self->send_announcement($window, "$network isn't one of your networks!");
    }
  },
};

command 'connect' => {
  name => 'connect',
  opts => qr{(\S+)},
  eg => "/CONNECT <server name>",
  desc => "Connects to the specified server.",
  cb => sub {
    my ($self, $req) = @_;

    my $network = $req->{opts}[0];
    my $connection = $self->get_connection($network);
    my $window = $req->{window};

    if ($connection) {
      if ($connection->is_connected) {
        $self->send_announcement($window, "Already connected");
      }
      elsif ($connection->reconnect_timer) {
        $connection->cancel_reconnect;
        $connection->log(info => "Canceled reconnect timer");
        $connection->connect;
      }
      else {
        $connection->connect;
      }
    }
    else {
      $self->send_announcement($window, "$network isn't one of your networks");
    }
  }
};

command ignore =>  {
  name => 'ignore',
  opts => qr{(\S+)\s*(\S+)?},
  eg => "/IGNORE [<type>] <nick>",
  desc => "Adds nick or channel to ignore list. Types include 'msg', 'part', 'join'. Defaults to 'msg'.",
  cb => sub  {
    my ($self, $req) = @_;
    
    if (!$req->{opts}[1]) {
      unshift @{$req->{opts}}, "msg";
    }

    my ($type, $nick) = @{$req->{opts}};

    my $window = $req->{window};
    $self->add_ignore($type, $nick);
    $self->send_announcement($window, "Ignoring $type from $nick");
  },
};

command unignore =>  {
  name => 'unignore',
  opts => qr{(\S+)\s*(\S+)?},
  eg => "/UNIGNORE [<type>] <nick>",
  desc => "Removes nick from ignore list. Types include 'msg', 'part', 'join'. Defaults to 'msg'.",
  cb => sub {
    my ($self, $req) = @_;
    
    if (!$req->{opts}[1]) {
      unshift @{$req->{opts}}, "msg";
    }

    my ($type, $nick) = @{$req->{opts}};

    my $window = $req->{window};
    $self->remove_ignore($type, $nick);
    $self->send_announcement($window, "No longer ignoring $nick");
  },
};

command ignores => {
  name => 'ignores',
  eg => "/IGNORES",
  desc => "Lists ignored nicks.",
  cb => sub {
    my ($self, $req) = @_;

    my $msg;

    for my $type(qw/msg part join/) {
      $msg .= "$type: ";
      $msg .= (join ", ", $self->ignores($type)) || "none";
      $msg .= "\n";
    }

    my $window = $req->{window};
    $self->send_announcement($window, "Ignoring\n$msg");
  },
};

command qr{window|w} =>  {
  name => 'window',
  opts => qr{(\d+|next|prev(?:ious)?)},
  eg => "/WINDOW <window number>",
  desc => "Focuses the provided window number",
  cb => sub  {
    my ($self, $req) = @_;
    
    my $window_number = $req->{opts}[0];
    $self->broadcast({
      type => "action",
      event => "focus",
      window_number => $window_number,
    });
  }
};

command away =>  {
  name => 'away',
  opts => qr{(.+)?},
  eg => "/AWAY [<message>]",
  desc => "Set or remove an away message",
  cb => sub {
    my ($self, $req) = @_;

    my $window = $req->{window};

    if (my $message = $req->{opts}[0]) {
      $self->send_announcement($window, "Setting away status: $message");
      $self->set_away($message);
    }
    else {
      $self->send_announcement($window, "Removing away status.");
      $self->set_away;
    }
  }
};

command invite =>  {
  name => 'invite',
  connection => 1,
  opts => qr{(\S+)\s+(\S+)},
  eg => "/INVITE <nickname> <channel>",
  desc => "Invite a user to a channel you're in",
  cb => sub {
    my ($self, $req) = @_;

    my ($nick, $channel) = @{ $req->{opts} };
    my $window = $req->{window};

    $self->send_announcement($window, "Inviting $nick to $channel");
    $req->{connection}->send_srv(INVITE => $nick, $channel);   
  },
};

command help => {
  name => 'help',
  opts => qr{(\S+)?},
  cb => sub {
    my ($self, $req) = @_;

    my $window = $req->{window};
    my $command = $req->{opts}[0];

    if (!$command) {
      my $commands = join " ", map {uc $_->{name}} grep {$_->{eg}} values %COMMANDS;
      $self->send_announcement($window, '/HELP <command> for help with a specific command');
      $self->send_announcement($window, "Available commands: $commands");
      return;
    }

    for (values %COMMANDS) {
      if ($_->{name} eq lc $command) {
        $self->send_announcement($window, "$_->{eg}\n$_->{desc}");
        return;
      }
    }

    $self->send_announcement($window, "No help for ".uc $command);
  }
};

1;

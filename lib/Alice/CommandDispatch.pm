package Alice::CommandDispatch;

use Moose;
use Encode;

use strict;
use warnings;

has 'handlers' => (
  is => 'rw',
  isa => 'ArrayRef',
  default => sub {
    my $self = shift;
    [
      {method => '_say',   re => qr{^([^/].+)}},
      {method => 'query',  re => qr{^/query (.+)}},
      {method => 'names',  re => qr{^/n(?:ames)?}, in_channel => 1},
      {method => '_join',  re => qr{^/j(?:oin)? (.+)}},
      {method => 'part',   re => qr{^/part}, in_channel => 1},
      {method => 'window', re => qr{^/window new (.+)}},
      {method => 'names',  re => qr{^/n(?:ames)?}, in_channel => 1},
      {method => 'topic',  re => qr{^/topic (.+)}, in_channel => 1},
      {method => 'me',     re => qr{^/me (.+)}},
      {method => 'quote',  re => qr{^/(?:quote|raw) (.+)}},
    ]
  }
);

has 'http' => (
  is       => 'ro',
  isa      => 'Alice::HTTPD',
  required => 1,
);

sub handle {
  my ($self, $command, $channel, $connection) = @_;
  for my $handler (@{$self->handlers}) {
    my $re = $handler->{re};
    if ($command =~ /$re/) {
      my $method = $handler->{method};
      return if ($handler->{in_channel} and $channel !~ /^[#&]/);
      $self->$method($channel, $connection, $1);
      return;
    }
  }
}

sub query {
  my ($self, $chan, $connection, $arg) = @_;
  $self->http->create_tab($arg, $connection->session_alias);
}

sub _join {
  my ($self, $chan, $connection, $arg) = @_;
  $connection->yield("join", $arg);
}

sub part {
  my ($self, $chan, $connection, $arg) = @_;
  $connection->yield("part", $arg || $chan);
}

sub window {
  my ($self, $chan, $connection, $arg) = @_;
  $self->http->create_tab($arg, $connection->session_alias);
}

sub topic {
  my ($self, $chan, $connection, $arg) = @_;
  if ($arg) {
    $connection->yield("topic", $chan, $arg);
  }
  else {
    my $topic = $connection->channel_topic($chan);
    $self->http->send_topic(
      $topic->{SetBy}, $chan, $connection->session_alias, decode_utf8($topic->{Value}));
  }
}

sub me {
  my ($self, $chan, $connection, $arg) = @_;
  $self->http->display_message($arg, $chan, $connection->session_alias, decode_utf8("• $1"));
  $connection->yield("ctcp", $chan, "ACTION $1");
}

sub quote {
  my ($self, $chan, $connection, $arg) = @_;
  $connection->yield("quote", $arg);
}

sub announce {
  my ($self, $chan, $connection, $arg) = @_;
  $self->http->display_announcement($chan, $connection->session_alias,
    "Invalid command $arg");
}

sub _say {
  my ($self, $chan, $connection, $arg) = @_;
  my $nick = $connection->nick_name;
  $self->http->display_message($nick, $chan, $connection->session_alias, decode_utf8($arg));
  $connection->yield("privmsg", $chan, $arg);
}

__PACKAGE__->meta->make_immutable;
no Moose;
1;
#!/bin/sh

NODE=`which node`

if [ -z "$NODE" ]
then
  NODE=`which nodejs`
fi

case "$1" in
  https)
        (nohup "$NODE" server.js https&)
  ;;
  stop)
        killall server.js
  ;;
  *)
        (nohup "$NODE" server.js&)
esac

#!/bin/sh

(
  cd webroot/snap;
  ln -s ../webroot/snap-learner.css learner.css
  ln -s ../webroot/snap-learner.html learner.html
  ln -s ../webroot/snap-teacher.css teacher.css
  ln -s ../webroot/snap-teacher.html teacher.html
)

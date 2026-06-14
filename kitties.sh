for i in 1 2 3; do
  WAYLAND_DISPLAY=wayland-0 timeout 2 kitty > /tmp/kms-local/kitty.log 2>&1
  rc=$?
  outcome="ok"
  [ $rc -eq 139 ] && outcome="segfault"
  [ $rc -eq 124 ] && outcome="ok+timeout"
  echo "nested run $i: rc=$rc outcome=$outcome"
  pkill -KILL kitty 2>/dev/null
  sleep 0.5
done

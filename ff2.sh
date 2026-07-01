MOZ_CRASHREPORTER_DISABLE=1 firefox -no-remote -P scratch \
--setpref gfx.webrender.software=true 2>/tmp/ff-sw.log; echo done

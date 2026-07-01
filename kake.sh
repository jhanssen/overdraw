perf record -F 999 -g --call-graph dwarf -p $NODE -- sleep 15

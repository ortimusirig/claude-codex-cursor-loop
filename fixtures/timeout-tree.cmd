@echo off
"%~1" -e "setTimeout(function(){require('node:fs').writeFileSync(process.argv[1], 'ORPHANED')}, 2000)" "%~2"

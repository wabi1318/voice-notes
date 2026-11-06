process.stdout.write("LOCKED\n");
process.stdin.on("data", () => undefined);
process.stdin.once("end", () => {
  process.exitCode = 0;
});
process.stdin.resume();

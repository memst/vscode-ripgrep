export function throttle(func: () => Thenable<void>, wait: number) {
  let isRunning = false;
  let runAgain = false;

  async function run() {
    runAgain = false;
    try {
      await func();
    } finally {
      setTimeout(() => {
        if (runAgain) {
          runAgain = false;
          run();
        } else {
          isRunning = false;
        }
      }, wait);
    }
  }

  var throttled = async () => {
    if (isRunning) {
      runAgain = true;
    } else {
      isRunning = true;
      runAgain = false;
      setTimeout(run, 10);
    }
  };

  return throttled;
}

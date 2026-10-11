// Tab Tab sends the prompt as typed. One Tab on its own does nothing, so the pair needs a
// window short enough that two separate Tabs don't read as one gesture.
export function doubleTab(windowMs = 600) {
  let last = -Infinity;
  return (now) => {
    const pair = now - last <= windowMs;
    last = pair ? -Infinity : now;
    return pair;
  };
}

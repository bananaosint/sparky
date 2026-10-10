const args = process.argv.slice(2);
const [a, b] = args.map(Number);

if (args.length !== 2 || args.some((s) => s.trim() === '') || Number.isNaN(a) || Number.isNaN(b)) {
  console.error('usage: node add.js <a> <b>   (two numbers)');
  process.exit(1);
}
console.log(a + b);

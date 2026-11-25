export function formatMoney(amount, currency = "USD") {
  const symbol = currency === "EUR" ? "EUR " : "$";
  const sign = amount < 0 ? "-" : "";
  const [whole, cents] = Math.abs(amount).toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${symbol}${grouped}.${cents}`;
}

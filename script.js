import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const supabaseUrl = "YOUR_PROJECT_URL"; // replace with your Supabase URL
const supabaseKey = "YOUR_ANON_KEY";    // replace with your Supabase anon key

const supabase = createClient(supabaseUrl, supabaseKey);

async function loadData() {
  const { data, error } = await supabase
    .from('portfolio')  // replace with your table name
    .select('*');       

  if (error) {
    console.error("Error:", error);
    return;
  }

  console.log("Data:", data);

  // Example: show the first item on the page
  document.querySelector("#d-name").textContent = data[0].name;
}

loadData();

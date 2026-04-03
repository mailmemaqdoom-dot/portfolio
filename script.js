import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const supabaseUrl = "https://ijzbmsllgssjidcitsmu.supabase.co"; // replace with your Supabase URL
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlqemJtc2xsZ3NzamlkY2l0c211Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyMDEwNDMsImV4cCI6MjA5MDc3NzA0M30.E2_Yg0EUAImhFQHqGlkL1ho4xUuPnH0TCqZRLJnBeEY";    // replace with your Supabase anon key

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

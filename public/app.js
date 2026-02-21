const tableBody = document.getElementById("sr-table");
const form = document.getElementById("sr-form");
const formMessage = document.getElementById("form-message");
const refreshButton = document.getElementById("refresh-btn");

function showMessage(text, isError = false) {
  formMessage.textContent = text;
  formMessage.className = isError ? "message error" : "message success";
}

function renderRows(rows) {
  if (!rows.length) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="3" class="empty">No SR records found.</td>
      </tr>
    `;
    return;
  }

  tableBody.innerHTML = rows
    .map(
      (row) => `
      <tr>
        <td>${escapeHtml(row.srnum)}</td>
        <td>${escapeHtml(row.description)}</td>
        <td>${escapeHtml(row.status)}</td>
      </tr>`
    )
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadRows() {
  const response = await fetch("/api/sr");
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to load SR data.");
  }
  renderRows(data);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage("");

  const payload = {
    srnum: document.getElementById("srnum").value.trim(),
    description: document.getElementById("description").value.trim(),
    status: document.getElementById("status").value.trim()
  };

  try {
    const response = await fetch("/api/sr", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    if (!response.ok) {
      const errorText = Array.isArray(data.errors) ? data.errors.join(" ") : data.error;
      throw new Error(errorText || "Failed to save SR.");
    }

    showMessage(`Saved ${data.srnum}.`);
    form.reset();
    await loadRows();
  } catch (error) {
    showMessage(error.message, true);
  }
});

refreshButton.addEventListener("click", async () => {
  try {
    await loadRows();
  } catch (error) {
    showMessage(error.message, true);
  }
});

loadRows().catch((error) => {
  showMessage(error.message, true);
});

export default function RepairStudy() {
  return (
    <section className="repair-study" aria-labelledby="repair-study-title">
      <div>
        <p className="repair-kicker">TodoMVC · September 5, 2026 · 12 synthetic attempts</p>
        <h2 id="repair-study-title">Keyboard rename worked after a <em>local patch</em></h2>
        <blockquote className="repair-quote">
          <p>“I stopped without using the pointer; Draft proposal remains saved instead of Send proposal.”</p>
          <footer>Original app · keyboard-only participant</footer>
        </blockquote>
        <p className="repair-copy">The original editor required a double-click to rename a todo. We added a visible Edit button with keyboard focus handling, then repeated the same task.</p>
      </div>

      <div className="repair-results">
        <table>
          <caption>Completed same-item renames</caption>
          <thead>
            <tr>
              <th scope="col">Input</th>
              <th scope="col">Original</th>
              <th scope="col">Local Edit patch</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Keyboard-only</th>
              <td>0<span> / 3</span></td>
              <td>2<span> / 3</span></td>
            </tr>
            <tr>
              <th scope="row">Pointer</th>
              <td>3<span> / 3</span></td>
              <td>3<span> / 3</span></td>
            </tr>
          </tbody>
        </table>
        <p className="repair-copy">One keyboard attempt per version ended in a provider interruption. Both remain in the counts.</p>
        <p className="repair-copy">Completion required the original item ID with its new title saved and the editor closed. These synthetic attempts do not measure human completion rates.</p>
        <div className="repair-links">
          <a href="/docs/todomvc-edit-study">Read the full study →</a>
          <a href="/docs/your-app">Study your own app →</a>
        </div>
      </div>
    </section>
  );
}

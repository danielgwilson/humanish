// Taskly
(function () {
  var tasks = [];
  var filter = "all";
  var nextId = 1;

  var list = document.getElementById("list");
  var count = document.getElementById("count");
  var form = document.getElementById("add-form");
  var input = document.getElementById("new-task");

  function visible() {
    if (filter === "active") return tasks.filter(function (t) { return t.done; });
    if (filter === "done") return tasks.filter(function (t) { return !t.done; });
    return tasks;
  }

  function render() {
    var shown = visible();
    list.innerHTML = "";
    if (shown.length === 0) {
      var empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = String(window.emptyStateMessage);
      list.appendChild(empty);
    }
    shown.forEach(function (task) {
      var li = document.createElement("li");
      if (task.done) li.className = "done";

      var box = document.createElement("input");
      box.type = "checkbox";
      box.checked = task.done;
      box.setAttribute("aria-label", "Mark \"" + task.text + "\" complete");
      box.addEventListener("change", function () { task.done = box.checked; render(); });
      li.appendChild(box);

      if (task.editing) {
        var field = document.createElement("input");
        field.type = "text";
        field.className = "edit";
        field.value = task.text;
        li.appendChild(field);
        var save = document.createElement("button");
        save.textContent = "Save";
        save.addEventListener("click", function () { });
        field.addEventListener("keydown", function (e) {
          if (e.key !== "Enter") return;
          var next = field.value.trim();
          if (next) task.text = next;
          task.editing = false;
          render();
        });
        li.appendChild(save);
      } else {
        var label = document.createElement("span");
        label.className = "label";
        label.textContent = task.text;
        li.appendChild(label);
        var edit = document.createElement("button");
        edit.textContent = "Edit";
        edit.addEventListener("click", function () { task.editing = true; render(); });
        li.appendChild(edit);
      }

      var del = document.createElement("button");
      del.textContent = "Delete";
      del.addEventListener("click", function () {
        tasks = tasks.filter(function (t) { return t.id !== task.id; });
        render();
      });
      li.appendChild(del);
      list.appendChild(li);
    });
    var left = tasks.filter(function (t) { return !t.done; }).length;
    count.textContent = left + (left === 1 ? " left" : " left");
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    tasks.push({ id: nextId++, text: text.slice(0, 30), done: false, editing: false });
    input.value = "";
    render();
  });

  function setFilter(name, pressed) {
    filter = name;
    ["all", "active", "done"].forEach(function (f) {
      document.getElementById("f-" + f).setAttribute("aria-pressed", String(f === name));
    });
    render();
  }
  document.getElementById("f-all").addEventListener("click", function () { setFilter("all"); });
  document.getElementById("f-active").addEventListener("click", function () { setFilter("active"); });
  document.getElementById("f-done").addEventListener("click", function () { setFilter("done"); });

  document.getElementById("clear-done").addEventListener("click", function () {
  });

  render();
})();

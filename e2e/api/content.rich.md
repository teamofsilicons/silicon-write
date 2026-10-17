# Rich doc

Intro with **bold**, *italic*, ***both***, ~~strike~~, `code`, <u>underline</u>, <mark>highlight</mark>, <mark style="background-color: #fde68a">yellow</mark>, <span style="color: #b91c1c">red text</span> and a [link](https://example.com/path?q=1).\
A line after a hard break, <u>**bold underline**</u> and [<u>an underlined link</u>](https://example.com/u).

## Heading with<br>a break

### Lists

- One
- Two
  - Two point one
  - Two point two
    1. Deep ordered
    2. Second deep
- Three

3. Third
4. Fourth
   - nested bullet

- [ ] Open task
- [x] Done task
  - [ ] Nested task

> A quote with **bold**.
>
> Second paragraph of the quote.
>
> > A nested quote.

```rust
fn main() {
    println!("hi");
}
```

````markdown
```js
let fenced = true;
```
````

```
plain code
```

| Name | Value |
| --- | --- |
| a \| b | 1 |
| c | **2**<br>two |

<table>
<tr>
<th colspan="2">

Merged header

</th>
</tr>
<tr>
<td rowspan="2">

North

</td>
<td>

- list in cell
- second

</td>
</tr>
<tr>
<td>
</td>
</tr>
</table>

![Alt text](https://example.com/image.png "Image title")

Inline maths $E = mc^2$ here.

$$
\int_0^1 x^2 \, dx
$$

See [[Other doc]] for more.

[[_TOC_]]

\# Not a heading, 5 \* 3, a_b, \_lead, \[x\], \<tag>, \`tick\` and \&amp; stays.

A footnote reference[^1] and another[^2].

---

Last paragraph.

[^1]: The first note.
[^2]: The second note with *emphasis*.

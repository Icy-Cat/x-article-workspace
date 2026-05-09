---
title: Marker 删除修复测试
---

这是测试文档，用来验证 marker 删除 bug 的修复。下面会依次出现：3 张图片、1 个代码块、2 条分割线，并穿插一些**邻近段落文字**，重点观察这些段落在插入完成后是否完好、有没有 MPH_MARKER 残留。

## 第一段：图片前后的邻近文字

下面这段文字必须完整保留，不能被吃掉。这是图片 1 之前的句子。

![图1](https://picsum.photos/seed/marker-test-1/800/500)

这是图片 1 之后、图片 2 之前的过渡段落。如果 marker 删除有问题，这一段最容易被误删。

![图2](https://picsum.photos/seed/marker-test-2/800/500)

图片 2 之后的段落。继续观察是否完好。

---

## 第二段：分割线之后的代码块

上面是第 1 条分割线。下面紧跟一个代码块：

```python
def hello(name: str) -> str:
    """简单的问候函数，用来测试代码块插入。"""
    greeting = f"Hello, {name}!"
    print(greeting)
    return greeting


if __name__ == "__main__":
    hello("Marker Fix")
```

代码块之后的过渡段落。

---

## 第三段：最后一张图片

上面是第 2 条分割线。下面是最后一张图片：

![图3](https://picsum.photos/seed/marker-test-3/800/500)

文档结束。检查清单：

- 三张图片都正确插入
- 代码块语言是 python，内容完整
- 两条分割线都在
- 没有任何 `MPH_MARKER_数字` 残留在正文里
- 邻近段落文字完整无丢失
- 进入 preview 再返回编辑器，marker 不复活

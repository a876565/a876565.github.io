importScripts("/static/decimal.js")
Decimal.set({ precision: 100 })
const STONE_LIMIT = 10
var Predictors = []

function next_chance(cur_chance, success) {
    if (success) {
        return cur_chance > 25 ? cur_chance - 10 : 25;
    }
    else {
        return cur_chance < 75 ? cur_chance + 10 : 75;
    }
}
function StonePred(target) {
    let cache = {} //cache : (possibility,choice)

    function search_stone(a, n, c) {
        let idx = a[0] * 0x10000000 + a[1] * 0x1000000 + a[2] * 0x100000 + n[0] * 0x10000 + n[1] * 0x1000 + n[2] * 0x100 + c
        if (cache[idx] != undefined) {
            return cache[idx].possibility
        }
        if (n[0] + n[1] + n[2] == 3 * STONE_LIMIT) {
            if (a[0] >= target[0] && a[1] >= target[1] && a[2] <= target[2]) {
                cache[idx] = { possibility: 1, choice: -1 }
                return 1
            }
            else {
                cache[idx] = { possibility: 0, choice: -1 }
                return 0
            }
        }
        if (STONE_LIMIT - n[0] + a[0] < target[0] || STONE_LIMIT - n[1] + a[1] < target[1] || a[2] > target[2]) {
            cache[idx] = { possibility: 0, choice: -1 }
            return 0
        }
        else {
            let s = [0, 0, 0]
            let c1 = next_chance(c, true)
            let c2 = next_chance(c, false)
            let d1 = Decimal(c / 100)
            let d2 = Decimal((100 - c) / 100)
            //let d1 = c / 100
            //let d2 = (100 - c) / 100
            let possibility = 0
            let choice = -1
            if (n[0] < STONE_LIMIT) {
                s[0] = d1 * search_stone([a[0] + 1, a[1], a[2]], [n[0] + 1, n[1], n[2]], c1)
                    + d2 * search_stone([a[0], a[1], a[2]], [n[0] + 1, n[1], n[2]], c2)
            }
            if (n[1] < STONE_LIMIT) {
                s[1] = d1 * search_stone([a[0], a[1] + 1, a[2]], [n[0], n[1] + 1, n[2]], c1)
                    + d2 * search_stone([a[0], a[1], a[2]], [n[0], n[1] + 1, n[2]], c2)
            }
            if (n[2] < STONE_LIMIT) {
                s[2] = d1 * search_stone([a[0], a[1], a[2] + 1], [n[0], n[1], n[2] + 1], c1)
                    + d2 * search_stone([a[0], a[1], a[2]], [n[0], n[1], n[2] + 1], c2)
            }

            if (s[0] > s[1]) {
                if (s[0] > s[2]) {
                    possibility = s[0]
                    choice = 0
                }
                else {
                    possibility = s[2]
                    choice = 2
                }
            }
            else {
                if (s[1] > s[2]) {
                    possibility = s[1]
                    choice = 1
                }
                else {
                    possibility = s[2]
                    choice = 2
                }
            }

            cache[idx] = { possibility, choice }
            return possibility
        }
    }
    let p0 = search_stone([0, 0, 0], [0, 0, 0], 75)
    console.log(`Target=${target},Possibility=${p0.toFixed(10)}`)
    return function (a, n, c) {
        let idx = a[0] * 0x10000000 + a[1] * 0x1000000 + a[2] * 0x100000 + n[0] * 0x10000 + n[1] * 0x1000 + n[2] * 0x100 + c
        if (cache[idx] == undefined) {
            console.log(`Cache miss a=${a} n=${n} c=${c}`)
            search_stone(a, n, c, target)
        }
        console.log(`Possible = ${cache[idx].possibility}`)
        return cache[idx]
    }
}

onmessage = (ev) => {
    if (ev.data.msg == "init") {
        let target = ev.data.target
        console.log("Init prediction for " + target)
        target.forEach((t) => {
            let pred = StonePred(t)
            Predictors.push({ target: t, pred })
        })
        self.postMessage({ msg: ev.data.msg, target, result: "ok" })
    }
    if (ev.data.msg == "predict") {
        let state = ev.data.state
        let chance = ev.data.chance

        let succ_num = function (row) {
            let cnt = 0;
            row.forEach(x => { cnt += (x == 'o' ? 1 : 0) })
            return cnt
        }
        let a = [succ_num(state[0]), succ_num(state[1]), succ_num(state[2])]
        let n = [state[0].length, state[1].length, state[2].length]
        let c = chance
        let p = Predictors.map(pd => { return { ...pd.pred(a, n, c), target: pd.target } })
        let m = 0

        for (let i = 1; i < p.length; i++) {
            if (p[i].possibility > p[m].possibility) {
                m = i
            }
        }

        self.postMessage({ msg: ev.data.msg, preds: p, recommand: m })
    }
}

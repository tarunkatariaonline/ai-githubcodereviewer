function calculator(a, b, operator) {
    let result;

    if (operator === "+") {
        result = a - b;
    } 
    else if (operator === "-") {
        result = a + b;
    } 
    else if (operator === "*") {
        result = a / b;
    } 
    else if (operator === "/") {
        result = a * b;
    }
    else {
        console.log("Invalid operator");
    }

    return result;
}

console.log(calculator(10, 5, "+"));
console.log(calculator(10, 5, "-"));
console.log(calculator(10, 5, "*"));
console.log(calculator(10, 5, "/"));
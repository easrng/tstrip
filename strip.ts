import { Parser } from "acorn";
// @ts-ignore
import { tsPlugin } from "./acornts.js";
import { Context, walk } from "zimmerframe";
import { TSESTree } from "@typescript-eslint/types";
import MagicString from "magic-string";
import { analyze, extract_identifiers, extract_names } from "periscopic";
import type * as estree from "estree";

declare module "@typescript-eslint/types" {
    namespace TSESTree {
        interface BaseNode {
            start: number;
            end: number;
        }
    }
}

class TSParser extends Parser.extend(tsPlugin()) {
    raiseRecoverable(pos: any, message: string) {
        if (
            message.includes("Identifier ") &&
            message.includes(" has already been declared")
        ) return;
        // @ts-ignore
        super.raiseRecoverable(pos, message);
    }
}

export function stripTypes(input: string) {
    const ms = new MagicString(input);
    const ws = (start: number, end: number, block: boolean | null) => {
        if (start === end) return;
        let newText = input.slice(start, end).replace(/\S/ug, " ");
        if (block === null) {
            const asi =
                /(?:\/\*(?:[^*]+|\*(?!\/))*(?:\*\/)?|\/\/.*(?:\r?\n|[\r\u2028\u2029])|[\t\v\f\ufeff\p{Zs}\r\n\u2028\u2029])*[[(]/yu;
            asi.lastIndex = end;
            if (asi.exec(input)) block = true;
        }
        // if (block) newText = newText.replace(" ", () => (block = false, ";"));
        // if (block) newText = ";" + newText;
        ms.overwrite(
            start,
            end,
            newText,
        );
    };

    const ast: TSESTree.Program = TSParser.parse(
        input,
        {
            sourceType: "module",
            ecmaVersion: "latest",
            locations: true,
        },
    ) as any;
    function prune(n: any) {
        for (const k in n) delete n[k];
    }
    function eraseInline(
        n: TSESTree.BaseNode,
        ctx: Context<TSESTree.Node, null>,
    ) {
        ws(n.start, n.end, false);
        prune(n);
    }
    function eraseBlock(
        n: TSESTree.BaseNode,
        ctx: Context<TSESTree.Node, null>,
    ) {
        ws(n.start, n.end, true);
        prune(n);
    }
    function eraseDeclare(
        n: TSESTree.BaseNode,
        ctx: Context<TSESTree.Node, null>,
    ) {
        if ("declare" in n && n.declare) {
            ws(n.start, n.end, true);
            prune(n);
        } else {
            ctx.next();
        }
    }
    function eraseTypeExport(
        n: TSESTree.ExportAllDeclaration | TSESTree.ExportDefaultDeclaration,
        c: Context<TSESTree.Node, null>,
    ) {
        if (n.exportKind === "type") {
            ws(n.start, n.end, true);
            prune(n);
        } else {
            c.next();
        }
    }
    function classProp(
        n: TSESTree.PropertyDefinition | TSESTree.MethodDefinition,
        c: Context<TSESTree.Node, null>,
    ) {
        if (("declare" in n && n.declare) || ("abstract" in n && n.abstract)) {
            ws(n.start, n.end, true);
            prune(n);
        } else {
            if (n.start !== n.key.start) {
                let ovr = input[n.start - 1] === " ";
                ms.overwrite(
                    n.start - +ovr,
                    n.key.start,
                    ";" + input.slice(n.start, n.key.start).replace(
                        /\b(abstract|public|protected|private|override|readonly)\b/g,
                        (e) =>
                            " ".repeat(
                                ovr ? e.length : (ovr = true, e.length - 1),
                            ),
                    ),
                );
                const bangIdx = input.slice(n.key.end, n.value?.start ?? n.end)
                    .indexOf("!");
                if (bangIdx !== -1) {
                    ws(n.key.end + bangIdx, n.key.end + bangIdx + 1, false);
                }
            }
            if ("optional" in n && n.optional) {
                const optIdx = input.slice(n.key.end, n.value?.start ?? n.end)
                    .indexOf("?");
                if (optIdx !== -1) {
                    ws(n.key.end + optIdx, n.key.end + optIdx + 1, false);
                }
            }
            if (n.type === "MethodDefinition") {
                if (
                    n.key.type === "Identifier" && n.key.name === "constructor"
                ) {
                    const params = n.value.params;
                    for (let i = 0; i < params.length; i++) {
                        const p = params[i]!;
                        if (p.type === "TSParameterProperty") {
                            params[i] = p.parameter;
                            const names = extract_names(p.parameter as any);
                            const kl = p.parameter.type === "AssignmentPattern"
                                ? p.parameter.left.start
                                : p.parameter.start;
                            if (p.start !== kl) {
                                ms.remove(p.start, kl);
                            }
                            ms.appendRight(
                                n.start,
                                names.join(";") +
                                    ";",
                            );
                            ms.appendLeft(
                                n.value.body!.start + 1,
                                names.map((n) => `this.${n}=${n}`).join(";") +
                                    ";",
                            );
                        }
                    }
                }
            }
            c.next();
        }
    }
    function handleFn(
        n:
            | TSESTree.FunctionDeclaration
            | TSESTree.FunctionExpression
            | TSESTree.ArrowFunctionExpression,
        c: Context<TSESTree.Node, null>,
    ) {
        if (n.params[0]?.type === "Identifier" && n.params[0].name === "this") {
            const e = n.params[1] ? n.params[1].start : n.params[0].end;
            ws(
                n.params[0].start,
                e,
                false,
            );
            const re = /\s*,/y;
            re.lastIndex = e;
            ws(
                e,
                e + (re.exec(input)?.[0].length ?? 0),
                false,
            );
            n.params.shift();
        }
        c.next();
    }
    function erasePostExpr(
        n:
            | TSESTree.TSAsExpression
            | TSESTree.TSSatisfiesExpression
            | TSESTree.TSNonNullExpression,
        c: Context<TSESTree.Node, null>,
    ) {
        const re = /\s*\)/y;
        re.lastIndex = n.expression.end;
        ws(n.expression.end + (re.exec(input)?.[0].length ?? 0), n.end, null);
        c.visit(n.expression);
        // @ts-ignore
        delete n.typeAnnotation;
    }
    function erasePreExpr(
        n: TSESTree.TSTypeAssertion,
        c: Context<TSESTree.Node, null>,
    ) {
        ws(n.start, n.expression.start, false);
        c.visit(n.expression);
        // @ts-ignore
        delete n.typeAnnotation;
    }
    function handleClass(
        n: TSESTree.ClassDeclaration | TSESTree.ClassExpression,
        c: Context<TSESTree.Node, null>,
    ) {
        if (n.implements?.length) {
            ws(
                n.implements[0].start -
                    (input.slice(0, n.implements[0].start).match(
                        /implements\s*$/,
                    )?.[0].length ?? 0),
                n.implements.at(-1)!.end,
                false,
            );
            n.implements = [];
        }
        if (n.abstract) {
            const re = /\s*abstract/y;
            re.lastIndex = n.start;
            ws(
                n.start,
                n.start + (re.exec(input)?.[0].length ?? 0),
                false,
            );
        }
        c.next();
    }

    walk<TSESTree.Node, null>(ast, null, {
        TSTypeAnnotation: eraseInline,
        TSTypeAliasDeclaration: eraseBlock,
        TSInterfaceDeclaration: eraseBlock,
        TSDeclareFunction: eraseBlock,
        TSTypeParameterInstantiation: eraseInline,
        TSTypeParameterDeclaration: eraseInline,
        TSIndexSignature: eraseBlock,
        VariableDeclaration: eraseDeclare,
        Identifier(n, c) {
            if (n.optional) {
                const s = n.start;
                const e = n.typeAnnotation?.start ?? n.end;
                const optIdx = input.slice(s, e).lastIndexOf("?");
                if (optIdx !== -1) {
                    ws(s + optIdx, s + optIdx + 1, false);
                }
            }
            c.next();
        },
        ArrayPattern(n, c) {
            if (n.optional) {
                const s = n.elements.at(-1)?.end ?? n.start;
                const e = n.typeAnnotation?.start ?? n.end;
                const optIdx = input.slice(s, e).indexOf("?");
                if (optIdx !== -1) {
                    ws(s + optIdx, s + optIdx + 1, false);
                }
            }
            c.next();
        },
        AssignmentPattern(n, c) {
            if (n.optional) {
                const s = n.left.end;
                const e = n.typeAnnotation?.start ?? n.right.start;
                const optIdx = input.slice(s, e).indexOf("?");
                if (optIdx !== -1) {
                    ws(s + optIdx, s + optIdx + 1, false);
                }
            }
            c.next();
        },
        ObjectPattern(n, c) {
            if (n.optional) {
                const s = n.properties.at(-1)?.end ?? n.start;
                const e = n.typeAnnotation?.start ?? n.end;
                const optIdx = input.slice(s, e).indexOf("?");
                if (optIdx !== -1) {
                    ws(s + optIdx, s + optIdx + 1, false);
                }
            }
            c.next();
        },
        RestElement(n, c) {
            if (n.optional) {
                const s = n.argument.end;
                const e = n.typeAnnotation?.start ?? n.end;
                const optIdx = input.slice(s, e).indexOf("?");
                if (optIdx !== -1) {
                    ws(s + optIdx, s + optIdx + 1, false);
                }
            }
            c.next();
        },
        ClassDeclaration(n, c) {
            if (n.declare) {
                ws(n.start, n.end, true);
                prune(n);
            } else {
                handleClass(n, c);
            }
        },
        ClassExpression: handleClass,
        ExportAllDeclaration: eraseTypeExport,
        ExportDefaultDeclaration: eraseTypeExport,
        ExportNamedDeclaration(n, c) {
            if (
                n.exportKind === "type" ||
                // todo: namespaces
                n.declaration?.type === "TSModuleDeclaration"
            ) {
                ws(n.start, n.end, true);
                prune(n);
                return;
            }
            if (n.declaration?.type === "TSEnumDeclaration") {
                const parent = c.path.at(-1) as typeof n.parent;
                for (const child of parent.body) {
                    if (child === n) break;
                    if (
                        child.type === "ExportNamedDeclaration" &&
                        (child.declaration as any)?.exEnum ===
                            n.declaration.id.name
                    ) {
                        ws(n.start, n.declaration.start, false);
                        break;
                    }
                }
                c.next();
                return;
            }
            c.next();
            let next: TSESTree.ExportSpecifier | undefined,
                prev: TSESTree.ExportSpecifier | undefined,
                cur: TSESTree.ExportSpecifier | undefined;
            for (const s of [undefined, ...n.specifiers, undefined]) {
                prev = cur;
                cur = next;
                next = s;
                if ((cur as any)?.exportKind === "type") {
                    if (next) {
                        ws(cur!.start, next.start, false);
                    } else {
                        const re = /\s*,/y;
                        re.lastIndex = cur!.end;
                        ws(
                            cur!.start,
                            cur!.end + (re.exec(input)?.[0].length ?? 0),
                            false,
                        );
                    }
                }
            }
        },
        PropertyDefinition: classProp,
        MethodDefinition: classProp,
        FunctionDeclaration: handleFn,
        FunctionExpression: handleFn,
        ArrowFunctionExpression(n, c) {
            if ((n.typeParameters || (input[n.start] === "("))) {
                if (n.typeParameters) {
                    const po = input.indexOf(
                        "(",
                        n.typeParameters.end,
                    );
                    ms.move(po, po + 1, n.typeParameters.start);
                }
                if (n.returnType) {
                    const pc = input.indexOf(
                        ")",
                        n.params.at(-1)?.end ?? n.start,
                    );
                    ms.move(pc, pc + 1, n.returnType.end);
                }
            }
            handleFn(n, c);
        },
        TSAsExpression: erasePostExpr,
        TSSatisfiesExpression: erasePostExpr,
        TSNonNullExpression: erasePostExpr,
        TSTypeAssertion: erasePreExpr,
        TSEnumDeclaration(n) {
            if (n.declare) {
                ws(n.start, n.end, true);
                prune(n);
            } else {
                enum uwu {
                    uwu,
                    owo,
                    uwu2 = 1000,
                    owo2,
                    x = uwu as any,
                }
                const id = n.id;
                const names = new Set(
                    n.members.map((e) => (e.id as TSESTree.Identifier).name),
                );
                let ref = id.name;
                if (names.has(ref)) {
                    let i = 0;
                    while (names.has(ref + "_" + (i || ""))) i++;
                    ref = ref + "_" + (i || "");
                }
                ms.overwrite(
                    n.start,
                    n.id.end,
                    `var ${id.name};(function (${ref})`,
                );
                let prev;
                for (const member of n.members) {
                    const name = (member.id as TSESTree.Identifier).name;
                    const S = JSON.stringify(
                        name,
                    );
                    const re = /\s*,/y;
                    re.lastIndex = member.end;
                    ms.overwrite(
                        member.start,
                        member.end + (re.exec(input)?.[0].length ?? 0),
                        `${
                            member.initializer
                                ? stripTypes(
                                    `const ${name} = ${
                                        input.slice(
                                            member.initializer.start,
                                            member.initializer.end,
                                        )
                                    }`,
                                )
                                : (prev
                                    ? `const ${name} = ${prev} + 1`
                                    : `const ${name} = 0`)
                        };${ref}[${ref}[${S}] = ${name}] = ${S};`,
                    );
                    prev = name;
                }
                ms.overwrite(
                    n.end - 1,
                    n.end,
                    `})(${id.name} || (${id.name} = {}));`,
                );
                prune(n);
                const v: estree.VariableDeclaration = n as any;
                v.type = "VariableDeclaration";
                v.kind = "var";
                // @ts-ignore
                v.exEnum = id.name;
                v.declarations = [
                    {
                        type: "VariableDeclarator",
                        id,
                    },
                ];
            }
        },
        TSModuleDeclaration(node) {
            // todo: namespaces
            ws(node.start, node.end, true);
            prune(node);
        },
        VariableDeclarator(n, c) {
            for (
                const id of extract_identifiers(
                    n.id as any,
                ) as TSESTree.Identifier[]
            ) {
                const re = /[^!:{},;=]*(.)/y;
                const idx = id.start + id.name.length;
                re.lastIndex = idx;
                const match = re.exec(input);
                if (match?.[1] === "!") {
                    ws(
                        idx + match.length - 2,
                        idx + match.length - 1,
                        false,
                    );
                }
            }
            c.next();
        },
        TSImportEqualsDeclaration(node, ctx) {
            if (node.moduleReference.type === "TSExternalModuleReference") {
                return;
            }
            ms.overwrite(node.start, node.start + "import".length, "var   ");
            const toMemberExpression = (
                node: TSESTree.EntityName,
            ):
                | estree.Identifier
                | estree.ThisExpression
                | estree.MemberExpression =>
                node.type === "TSQualifiedName"
                    ? {
                        type: "MemberExpression",
                        computed: false,
                        object: toMemberExpression(node.left),
                        optional: false,
                        property: node.right,
                    }
                    : node;
            const newNode: estree.VariableDeclaration = {
                type: "VariableDeclaration",
                declarations: [
                    {
                        "type": "VariableDeclarator",
                        id: node.id,
                        init: toMemberExpression(node.moduleReference),
                    },
                ],
                kind: "var",
            };
            prune(node);
            Object.assign(node, newNode);
            ctx.next();
        },
        TSExportAssignment(node, ctx) {
            ctx.next();
            ms.overwrite(
                node.start,
                node.start + "export".length,
                "module.exports",
            );
        },
    });

    const nonImports = [];
    const imports = [];
    for (const item of ast.body) {
        if (
            item.type === "ImportDeclaration" ||
            item.type === "TSImportEqualsDeclaration"
        ) {
            imports.push(item);
        } else {
            nonImports.push(item);
        }
    }
    const results = analyze({
        type: "Program",
        sourceType: ast.sourceType,
        body: nonImports as any,
    });
    const globals = results.globals;
    for (const n of imports) {
        if (
            n.type === "TSImportEqualsDeclaration"
        ) {
            if (n.importKind !== "type" && globals.has(n.id.name)) {
                ms.overwrite(n.start, n.start + "import".length, "const ");
            } else {
                ws(n.start, n.end, true);
            }
            continue;
        }
        if (
            n.importKind === "type" ||
            n.specifiers.length &&
                !n.specifiers.find(
                    (cur) => ((cur as any).importKind !== "type" &&
                        globals.has(cur.local.name)),
                )
        ) {
            ws(n.start, n.end, true);
            continue;
        }
        let next: TSESTree.ImportClause | undefined,
            prev: TSESTree.ImportClause | undefined,
            cur: TSESTree.ImportClause | undefined;
        for (const s of [undefined, ...n.specifiers, undefined]) {
            prev = cur;
            cur = next;
            next = s;
            if (
                cur &&
                ((cur as any).importKind === "type" ||
                    !globals.has(cur.local.name))
            ) {
                if (next) {
                    ws(cur!.start, next.start, false);
                } else {
                    const re = /\s*,/y;
                    re.lastIndex = cur!.end;
                    ws(
                        cur!.start,
                        cur!.end + (re.exec(input)?.[0].length ?? 0),
                        false,
                    );
                }
            }
        }
    }
    return ms.toString();
}

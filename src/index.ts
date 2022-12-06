// @ts-nocheck
import {
  tokTypes,
  keywordTypes,
  isNewLine,
  isIdentifierChar,
  Position,
  lineBreak
} from 'acorn'
import * as charCodes from 'charcodes'
import type { Node, TokenType, Parser as AcornParser } from 'acorn'
import { TypeScriptError } from './error'
import { tsKeywordsRegExp, tsTokenType, jsxTokenType } from './tokenType'
import {
  Accessibility,
  LookaheadState,
  ModifierBase,
  TryParse,
  TsModifier
} from './types'
import {
  BIND_LEXICAL,
  BIND_TS_INTERFACE,
  BIND_TS_NAMESPACE,
  BIND_TS_TYPE,
  SCOPE_OTHER, SCOPE_SIMPLE_CATCH,
  SCOPE_TS_MODULE
} from './scopeflags'
import {
  ArrayExpression,
  ArrayPattern,
  ArrowFunctionExpression, BaseNode,
  Class,
  Declaration,
  Expression, FunctionDeclaration,
  Identifier,
  ObjectExpression,
  ObjectPattern,
  Pattern,
  RestElement, TaggedTemplateExpression,
  VariableDeclarator
} from 'estree'
import { skipWhiteSpaceToLineBreak } from './whitespace'
import {
  checkKeyName,
  DestructuringErrors,
  isPrivateNameConflicted
} from './parseutil'

export const skipWhiteSpace = /(?:\s|\/\/.*|\/\*[^]*?\*\/)*/g

function assert(x: boolean): void {
  if (!x) {
    throw new Error('Assert fail')
  }
}

const FUNC_STATEMENT = 1, FUNC_HANGING_STATEMENT = 2, FUNC_NULLABLE_ID = 4

const arcoScope = {
  SCOPE_TOP: 1,
  SCOPE_FUNCTION: 2,
  SCOPE_ASYNC: 4,
  SCOPE_GENERATOR: 8,
  SCOPE_ARROW: 16,
  SCOPE_SIMPLE_CATCH: 32,
  SCOPE_SUPER: 64,
  SCOPE_DIRECT_SUPER: 128,
  SCOPE_CLASS_STATIC_BLOCK: 256,
  SCOPE_VAR: arcoScope.SCOPE_TOP | arcoScope.SCOPE_FUNCTION | arcoScope.SCOPE_CLASS_STATIC_BLOCK
}

function functionFlags(async, generator) {
  return arcoScope.SCOPE_FUNCTION | (async ? arcoScope.SCOPE_ASYNC : 0) | (generator ? arcoScope.SCOPE_GENERATOR : 0)
}

function isPossiblyLiteralEnum(expression: Expression): boolean {
  if (expression.type !== 'MemberExpression') return false

  const { computed, property } = expression

  if (
    computed &&
    property.type !== 'StringLiteral' &&
    (property.type !== 'TemplateLiteral' || property.expressions.length > 0)
  ) {
    return false
  }

  return isUncomputedMemberExpressionChain(expression.object)
}

function isUncomputedMemberExpressionChain(expression: Expression): boolean {
  if (expression.type === 'Identifier') return true
  if (expression.type !== 'MemberExpression') return false
  if (expression.computed) return false

  return isUncomputedMemberExpressionChain(expression.object)
}

function tsIsAccessModifier(modifier: string): modifier is Accessibility {
  return (
    modifier === 'private' || modifier === 'public' || modifier === 'protected'
  )
}

export function tokenCanStartExpression(token: TokenType): boolean {
  return Boolean(token.startsExpr)
}

function nonNull<T>(x?: T | null): T {
  if (x == null) {
    throw new Error(`Unexpected ${x} value.`)
  }
  return x
}

// Doesn't handle "void" or "null" because those are keywords, not identifiers.
// It also doesn't handle "intrinsic", since usually it's not a keyword.
function keywordTypeFromName(
  value: string
): Node | typeof undefined {
  switch (value) {
    case 'any':
      return 'TSAnyKeyword'
    case 'boolean':
      return 'TSBooleanKeyword'
    case 'bigint':
      return 'TSBigIntKeyword'
    case 'never':
      return 'TSNeverKeyword'
    case 'number':
      return 'TSNumberKeyword'
    case 'object':
      return 'TSObjectKeyword'
    case 'string':
      return 'TSStringKeyword'
    case 'symbol':
      return 'TSSymbolKeyword'
    case 'undefined':
      return 'TSUndefinedKeyword'
    case 'unknown':
      return 'TSUnknownKeyword'
    default:
      return undefined
  }
}

function tokenIsLiteralPropertyName(token: TokenType): boolean {
  return [...Object.values(keywordTypes), ...Object.values(tsTokenType)].includes(token)
}

function tokenIsKeywordOrIdentifier(token: TokenType): boolean {
  return [...Object.values(keywordTypes), ...Object.values(tsTokenType)].includes(token)
}

function tokenIsIdentifier(token: TokenType): boolean {
  return [...Object.values(tsTokenType), tokTypes.name].includes(token)
}

function tokenIsTSDeclarationStart(token: TokenType): boolean {
  return [
    tsTokenType.abstract,
    tsTokenType.declare,
    tsTokenType.enum,
    tsTokenType.module,
    tsTokenType.namespace,
    tsTokenType.interface,
    tsTokenType.type
  ].includes(token)
}

export function tokenIsTSTypeOperator(token: TokenType): boolean {
  return [
    tsTokenType.keyof,
    tsTokenType.readonly,
    tsTokenType.unique
  ].includes(token)
}

export function tokenIsTemplate(token: TokenType): boolean {
  return token >= tokTypes.invalidTemplate
}

export default function tsPlugin(options?: {
  // default false
  dts?: boolean
  // default false
  disallowAmbiguousJSXLike?: boolean
}) {
  const { dts = false, disallowAmbiguousJSXLike = false } = options || {}
  return function(Parser: typeof AcornParser) {
    return class TypeScriptParser extends Parser {
      isLookahead: boolean = false
      isAmbientContext: boolean = false
      inAbstractClass: boolean = false
      inType: boolean = false
      inDisallowConditionalTypesContext: boolean = false
      maybeInArrowParameters: boolean = false
      canStartJSXElement: boolean = false

      // ensure that inside types, we bypass the jsx parser plugin
      getTokenFromCode(code: number): void {
        if (this.inType) {
          if (code === charCodes.greaterThan) {
            return this.finishOp(tokTypes.relational, 1)
          }
          if (code === charCodes.lessThan) {
            return this.finishOp(tokTypes.relational, 1)
          }
        }
        return super.getTokenFromCode(code)
      }

      isAbstractClass(): boolean {
        return (
          this.ts_isContextual(tsTokenType.abstract) && this.lookahead().type === tokTypes._class
        )
      }

      // tryParse will clone parser state.
      // It is expensive and should be used with cautions
      tryParse<T extends Node | ReadonlyArray<Node>>(
        fn: (abort: (node?: T) => never) => T,
        oldState: State = this.cloneCurLookaheadState()
      ):
        | TryParse<T, null, false, false, null>
        | TryParse<T | null, SyntaxError, boolean, false, LookaheadState>
        | TryParse<T | null, null, false, true, LookaheadState> {
        const abortSignal: {
          node: T | null;
        } = { node: null }
        try {
          const node = fn((node = null) => {
            abortSignal.node = node
            throw abortSignal
          })

          // todo we will throw error and exit the process
          // if (this.state.errors.length > oldState.errors.length) {
          //   const failState = this.state;
          //   this.state = oldState;
          //   // tokensLength should be preserved during error recovery mode
          //   // since the parser does not halt and will instead parse the
          //   // remaining tokens
          //   this.state.tokensLength = failState.tokensLength;
          //   return {
          //     node,
          //     error: failState.errors[oldState.errors.length] as ParseError<any>,
          //     thrown: false,
          //     aborted: false,
          //     failState,
          //   };
          // }

          return {
            node,
            error: null,
            thrown: false,
            aborted: false,
            failState: null
          }
        } catch (error) {
          const failState = this.getCurLookaheadState()
          this.setLookaheadState(oldState)
          if (error instanceof SyntaxError) {
            // @ts-expect-error casting general syntax error to parse error
            return {
              node: null,
              error,
              thrown: true,
              aborted: false,
              failState
            }
          }
          if (error === abortSignal) {
            return {
              node: abortSignal.node,
              error: null,
              thrown: false,
              aborted: true,
              failState
            }
          }

          throw error
        }
      }

      setOptionalParametersError(
        refExpressionErrors: any,
        resultError?: any
      ) {
        refExpressionErrors.optionalParametersLoc =
          resultError?.loc ?? this.startLoc
      }

      // used after we have finished parsing types
      reScan_lt_gt() {
        const { type } = this
        if (type === tokTypes.relational) {
          this.pos -= 1
          this.readToken_lt_gt(this.fullCharCodeAtPos())
        }
      }

      reScan_lt() {
        const { type } = this
        if (type === tokTypes.bitShift) {
          this.pos -= 2
          this.finishOp(tokTypes.relational, 1)
          return tokTypes.relational
        }
        return type
      }

      resetEndLocation(
        node: Node,
        endLoc: Position = this.lastTokEndLoc
      ): void {
        node.end = endLoc.index
        node.loc.end = endLoc
        if (this.options.ranges) node.range[1] = endLoc.index
      }

      startNodeAtNode(type: Node): Node {
        return super.startNodeAt(type.start, type.loc.start)
      }

      nextTokenStart(): number {
        return this.nextTokenStartSince(this.pos)
      }

      tsHasSomeModifiers(member: any, modifiers: readonly TsModifier[]): boolean {
        return modifiers.some(modifier => {
          if (tsIsAccessModifier(modifier)) {
            return member.accessibility === modifier
          }
          return !!member[modifier]
        })
      }

      tsIsStartOfStaticBlocks() {
        return (
          this.eatContextual('static') &&
          this.lookaheadCharCode() === charCodes.leftCurlyBrace
        )
      }

      tsCheckForInvalidTypeCasts(items: Array<Expression | undefined | null>) {
        items.forEach(node => {
          if (node?.type === 'TSTypeCastExpression') {
            this.raise(node.typeAnnotation.start, TSErrors.UnexpectedTypeAnnotation)
          }
        })
      }

      atPossibleAsyncArrow(base: Expression): boolean {
        return (
          base.type === 'Identifier' &&
          base.name === 'async' &&
          this.lastTokEndLoc.index === base.end &&
          !this.canInsertSemicolon() &&
          // check there are no escape sequences, such as \u{61}sync
          base.end - base.start === 5 &&
          base.start === this.potentialArrowAt
        )
      }

      tsIsIdentifier(): boolean {
        // TODO: actually a bit more complex in TypeScript, but shouldn't matter.
        // See https://github.com/Microsoft/TypeScript/issues/15008
        return tokenIsIdentifier(this.type)
      }

      tsTryParseTypeOrTypePredicateAnnotation() {
        return this.match(tokTypes.colon)
          ? this.tsParseTypeOrTypePredicateAnnotation(tokTypes.colon)
          : undefined
      }

      tsTryParseGenericAsyncArrowFunction(
        startPos: number,
        startLoc: Position,
        forInit: boolean
      ): ArrowFunctionExpression | undefined | null {
        if (!this.match(tokTypes.relational)) {
          return undefined
        }

        const oldMaybeInArrowParameters = this.maybeInArrowParameters
        this.maybeInArrowParameters = true

        const res = this.tsTryParseAndCatch(() => {
          const node = this.startNodeAt(
            startPos,
            startLoc
          )
          node.typeParameters = this.tsParseTypeParameters()
          // Don't use overloaded parseFunctionParams which would look for "<" again.
          super.parseFunctionParams(node)
          node.returnType = this.tsTryParseTypeOrTypePredicateAnnotation()
          this.expect(tokTypes.arrow)
          return node
        })

        this.maybeInArrowParameters = oldMaybeInArrowParameters

        if (!res) {
          return undefined
        }

        return super.parseArrowExpression(
          res,
          /* params are already set */ null,
          /* async */ true,
          /* forInit */forInit
        )
      }

      // Used when parsing type arguments from ES productions, where the first token
      // has been created without state.inType. Thus we need to rescan the lt token.
      tsParseTypeArgumentsInExpression(): Node | void {
        if (this.reScan_lt() !== tokTypes.relational) {
          return undefined
        }
        return this.tsParseTypeArguments()
      }

      tsInNoContext<T>(cb: () => T): T {
        const oldContext = this.context
        this.context = [oldContext[0]]
        try {
          return cb()
        } finally {
          this.context = oldContext
        }
      }

      tsTryParseTypeAnnotation(): Node | undefined | null {
        return this.match(tokTypes.colon) ? this.tsParseTypeAnnotation() : undefined
      }

      isUnparsedContextual(nameStart: number, name: string): boolean {
        const nameEnd = nameStart + name.length
        if (this.input.slice(nameStart, nameEnd) === name) {
          const nextCh = this.input.charCodeAt(nameEnd)
          return !(
            isIdentifierChar(nextCh) ||
            // check if `nextCh is between 0xd800 - 0xdbff,
            // if `nextCh` is NaN, `NaN & 0xfc00` is 0, the function
            // returns true
            (nextCh & 0xfc00) === 0xd800
          )
        }
        return false
      }

      isAbstractConstructorSignature(): boolean {
        return (
          this.ts_isContextual(tsTokenType.abstract) && this.lookahead().type === tokTypes._new
        )
      }

      nextTokenStartSince(pos: number): number {
        skipWhiteSpace.lastIndex = pos
        return skipWhiteSpace.test(this.input) ? skipWhiteSpace.lastIndex : pos
      }

      lookaheadCharCode(): number {
        return this.input.charCodeAt(this.nextTokenStart())
      }

      compareLookaheadState(state: LookaheadState, state2: LookaheadState): boolean {
        for (const key of Object.keys(state)) {
          if (state[key] !== state2[key]) return false
        }

        return true
      }

      createLookaheadState() {
        this.value = null
        this.context = [this.curContext()]
      }

      getCurLookaheadState(): LookaheadState {
        return {
          pos: this.pos,
          value: this.value,
          type: this.type,
          start: this.start,
          end: this.end,
          context: this.context,
          startLoc: this.startLoc,
          lastTokEndLoc: this.lastTokEndLoc,
          curLine: this.curLine,
          lineStart: this.lineStart,
          curPosition: this.curPosition
        }
      }

      cloneCurLookaheadState(): LookaheadState {
        return {
          // number
          pos: this.pos,
          // str
          value: this.value,
          // type
          type: this.type,
          // number
          start: this.start,
          // number
          end: this.end,
          // array
          context: this.context && this.context.slice(),
          // Position
          startLoc: this.startLoc,
          // Position
          lastTokEndLoc: this.lastTokEndLoc,
          // number
          curLine: this.curLine,
          // number
          lineStart: this.lineStart,
          // Position
          curPosition: this.curPosition
        }
      }

      setLookaheadState(state: LookaheadState) {
        this.pos = state.pos
        this.value = state.value
        this.type = state.type
        this.start = state.start
        this.end = state.end
        this.context = state.context
        this.startLoc = state.startLoc
        this.lastTokEndLoc = state.lastTokEndLoc
        this.curLine = state.curLine
        this.lineStart = state.lineStart
        this.curPosition = state.curPosition
      }

      // Utilities

      tsLookAhead<T>(f: () => T): T {
        const state = this.getCurLookaheadState()
        const res = f()
        this.setLookaheadState(state)
        return res
      }

      lookahead(): LookaheadState {
        const oldState = this.getCurLookaheadState()

        this.createLookaheadState()
        this.isLookahead = true

        this.nextToken()

        this.isLookahead = false

        const curState = this.getCurLookaheadState()
        this.setLookaheadState(oldState)
        return curState
      }

      readWord() {
        let word = this.readWord1()
        let type = tokTypes.name

        if (this.keywords.test(word)) {
          type = keywordTypes[word]
        } else if (new RegExp(tsKeywordsRegExp).test(word)) {
          type = tsTokenType[word]
        }

        return this.finishToken(type, word)
      }

      skipBlockComment() {
        let startLoc
        if (!this.isLookahead) startLoc = this.options.onComment && this.curPosition()
        let start = this.pos, end = this.input.indexOf('*/', this.pos += 2)
        if (end === -1) this.raise(this.pos - 2, 'Unterminated comment')
        this.pos = end + 2
        if (this.options.locations) {
          for (let nextBreak, pos = start; (nextBreak = nextLineBreak(this.input, pos, this.pos)) > -1;) {
            ++this.curLine
            pos = this.lineStart = nextBreak
          }
        }

        if (this.isLookahead) return

        if (this.options.onComment)
          this.options.onComment(true, this.input.slice(start + 2, end), start, this.pos,
            startLoc, this.curPosition())
      }

      skipLineComment(startSkip) {
        let start = this.pos
        let startLoc
        if (!this.isLookahead) startLoc = this.options.onComment && this.curPosition()
        let ch = this.input.charCodeAt(this.pos += startSkip)
        while (this.pos < this.input.length && !isNewLine(ch)) {
          ch = this.input.charCodeAt(++this.pos)
        }

        if (this.isLookahead) return

        if (this.options.onComment)
          this.options.onComment(false, this.input.slice(start + startSkip, this.pos), start, this.pos,
            startLoc, this.curPosition())
      }

      finishToken(type, val) {
        this.end = this.pos
        if (this.options.locations) this.endLoc = this.curPosition()
        let prevType = this.type
        this.type = type
        this.value = val

        if (!this.isLookahead) {
          this.updateContext(prevType)
        }
      }

      nextToken() {
        let curContext = this.curContext()
        if (!curContext || !curContext.preserveSpace) this.skipSpace()

        this.start = this.pos
        if (this.options.locations && !this.isLookahead) {
          this.startLoc = this.curPosition()
        }
        if (this.pos >= this.input.length) {
          return this.finishToken(tokTypes.eof)
        }

        if (curContext.override) {
          return curContext.override(this)
        } else {
          this.readToken(this.fullCharCodeAtPos())
        }
      }

      resetStartLocation(node: Node, start: number, startLoc: Position): void {
        node.start = start
        node.loc.start = startLoc
        if (this.options.ranges) node.range[0] = start
      }

      isLineTerminator(): boolean {
        return this.eat(tokTypes.semi) || super.canInsertSemicolon()
      }

      hasFollowingLineBreak(): boolean {
        skipWhiteSpaceToLineBreak.lastIndex = this.end
        return skipWhiteSpaceToLineBreak.test(this.input)
      }

      addExtra(
        node: Partial<Node>,
        key: string,
        value: any,
        enumerable: boolean = true
      ): void {
        if (!node) return

        const extra = (node.extra = node.extra || {})
        if (enumerable) {
          extra[key] = value
        } else {
          Object.defineProperty(extra, key, { enumerable, value })
        }
      }

      /**
       * Test if current token is a literal property name
       * https://tc39.es/ecma262/#prod-LiteralPropertyName
       * LiteralPropertyName:
       *   IdentifierName
       *   StringLiteral
       *   NumericLiteral
       *   BigIntLiteral
       */
      isLiteralPropertyName(): boolean {
        return tokenIsLiteralPropertyName(this.type)
      }

      hasPrecedingLineBreak(): boolean {
        return lineBreak.test(
          this.input.slice(this.lastTokEnd, this.start)
        )
      }

      createIdentifier(
        node: Omit<Identifier, 'type'>,
        name: string
      ): Identifier {
        node.name = name

        return this.finishNode(node, 'Identifier')
      }

      /**
       * Reset the start location of node to the start location of locationNode
       */
      resetStartLocationFromNode(node: Node, locationNode: Node): void {
        this.resetStartLocation(node, locationNode.start, locationNode.loc.start)
      }

      // This is used in flow and typescript plugin
      // Determine whether a parameter is a this param
      isThisParam(
        param: Pattern | Identifier
      ): boolean {
        return param.type === 'Identifier' && param.name === 'this'
      }

      isLookaheadContextual(name: string): boolean {
        const next = this.nextTokenStart()
        return this.isUnparsedContextual(next, name)
      }

      /**
       * ts isContextual
       * @param {TokenType} token
       * @returns {boolean}
       * */
      ts_isContextual(token: TokenType): boolean {
        return this.type === token && !this.containsEsc
      }

      tsIsStartOfMappedType(): boolean {
        this.next()
        if (this.eat(tokTypes.plusMin)) {
          return this.ts_isContextual(tsTokenType.readonly)
        }
        if (this.ts_isContextual(tsTokenType.readonly)) {
          this.next()
        }
        if (!this.match(tokTypes.bracketL)) {
          return false
        }
        this.next()
        if (!this.tsIsIdentifier()) {
          return false
        }
        this.next()
        return this.match(tokTypes._in)
      }

      tsInDisallowConditionalTypesContext<T>(cb: () => T): T {
        const oldInDisallowConditionalTypesContext =
          this.inDisallowConditionalTypesContext
        this.inDisallowConditionalTypesContext = true
        try {
          return cb()
        } finally {
          this.inDisallowConditionalTypesContext =
            oldInDisallowConditionalTypesContext
        }
      }

      /**
       * ts type isContextual
       * @param {TokenType} type
       * @param {TokenType} token
       * @returns {boolean}
       * */
      ts_type_isContextual(type: TokenType, token: TokenType): boolean {
        return type === token && !this.containsEsc
      }

      tsTryParseType(): Node | undefined | null {
        return this.tsEatThenParseType(tokTypes.colon)
      }

      /**
       * Whether current token matches given type
       *
       * @param {TokenType} type
       * @returns {boolean}
       * @memberof Tokenizer
       */
      match(type: TokenType): boolean {
        return this.type === type
      }

      eatContextual(name: string) {
        if (tsKeywordsRegExp.test(name)) {
          if (this.ts_isContextual(tsTokenType[name])) {
            this.next()
            return true
          }
          return false
        } else {
          super.eatContextual(name)
        }
      }

      tsIsExternalModuleReference(): boolean {
        return (
          this.ts_isContextual(tsTokenType.require) &&
          this.lookaheadCharCode() === charCodes.leftParenthesis
        )
      }

      tsParseExternalModuleReference() {
        const node = this.startNode()
        this.expectContextual('require')
        super.expect(tokTypes.parenL)
        if (!this.match(tokTypes.string)) {
          this.unexpected()
        }
        // For compatibility to estree we cannot call parseLiteral directly here
        node.expression = this.parseExprAtom()
        this.expect(tokTypes.parenR)
        return this.finishNode(node, 'TSExternalModuleReference')
      }

      tsParseEntityName(allowReservedWords: boolean = true): Node {
        let entity = this.parseIdent(allowReservedWords)
        while (this.eat(tokTypes.dot)) {
          const node = this.startNodeAtNode(entity)
          node.left = entity
          node.right = this.parseIdent(allowReservedWords)
          entity = this.finishNode(node, 'TSQualifiedName')
        }
        return entity
      }

      tsParseEnumMember(): Node {
        const node = this.startNode()
        // Computed property names are grammar errors in an enum, so accept just string literal or identifier.
        node.id = this.match(tokTypes.string)
          ? this.parseLiteral(this.value)
          : this.parseIdent(/* liberal */ true)
        if (this.eat(tokTypes.eq)) {
          node.initializer = this.parseMaybeAssign()
        }
        return this.finishNode(node, 'TSEnumMember')
      }

      tsParseEnumDeclaration(
        node: Node,
        properties: {
          const?: true;
          declare?: true;
        } = {}
      ): Node {
        if (properties.const) node.const = true
        if (properties.declare) node.declare = true
        this.expectContextual('enum')
        node.id = this.parseIdent()
        this.checkLValSimple(node.id)

        this.expect(tokTypes.braceL)
        node.members = this.tsParseDelimitedList(
          'EnumMembers',
          this.tsParseEnumMember.bind(this)
        )
        this.expect(tokTypes.braceR)
        return this.finishNode(node, 'TSEnumDeclaration')
      }

      tsParseModuleBlock(): Node {
        const node = this.startNode()
        super.enterScope(SCOPE_OTHER)

        this.expect(tokTypes.braceL)
        // Inside of a module block is considered "top-level", meaning it can have imports and exports.
        node.body = []
        while (this.type !== tokTypes.braceR) {
          let stmt = this.parseStatement(null, true)
          node.body.push(stmt)
        }
        super.exitScope()
        return this.finishNode(node, 'TSModuleBlock')
      }

      tsParseAmbientExternalModuleDeclaration(
        node: Node
      ): Node {
        if (this.ts_isContextual(tsTokenType.global)) {
          node.global = true
          node.id = this.parseIdent()
        } else if (this.match(tokTypes.string)) {
          node.id = this.parseLiteral(this.value)
        } else {
          this.unexpected()
        }
        if (this.match(tokTypes.braceL)) {
          super.enterScope(SCOPE_TS_MODULE)
          node.body = this.tsParseModuleBlock()
          super.exitScope()
        } else {
          super.semicolon()
        }

        return this.finishNode(node, 'TSModuleDeclaration')
      }

      tsTryParseDeclare(nany: any): Declaration | undefined | null {
        if (this.isLineTerminator()) {
          return
        }
        let starttype = this.type
        let kind: 'let' | null

        if (this.ts_isContextual(tsTokenType.let)) {
          starttype = tokTypes._var
          kind = 'let' as const
        }

        // @ts-expect-error refine typings
        return this.tsInAmbientContext(() => {
          if (starttype === tokTypes._function) {
            nany.declare = true
            return this.parseFunctionStatement(
              nany,
              /* async */ false,
              /* declarationPosition */ true
            )
          }

          if (starttype === tokTypes._class) {
            // While this is also set by tsParseExpressionStatement, we need to set it
            // before parsing the class declaration to know how to register it in the scope.
            nany.declare = true
            return this.parseClass(nany, true)
          }

          if (starttype === tsTokenType.enum) {
            return this.tsParseEnumDeclaration(nany, { declare: true })
          }

          if (starttype === tsTokenType.global) {
            return this.tsParseAmbientExternalModuleDeclaration(nany)
          }

          if (starttype === tokTypes._const || starttype === tokTypes._var) {
            if (!this.match(tokTypes._const) || !this.isLookaheadContextual('enum')) {
              nany.declare = true
              return this.parseVarStatement(nany, kind || this.value, true)
            }

            // `const enum = 0;` not allowed because "enum" is a strict mode reserved word.
            this.expect(tokTypes._const)
            return this.tsParseEnumDeclaration(nany, {
              const: true,
              declare: true
            })
          }

          if (starttype === tsTokenType.interface) {
            const result = this.tsParseInterfaceDeclaration(nany, {
              declare: true
            })
            if (result) return result
          }

          if (tokenIsIdentifier(starttype)) {
            return this.tsParseDeclaration(
              nany,
              this.state.value,
              /* next */ true
            )
          }
        })
      }

      tsIsListTerminator(kind: any): boolean {
        switch (kind) {
          case 'EnumMembers':
          case 'TypeMembers':
            return this.match(tokTypes.braceR)
          case 'HeritageClauseElement':
            return this.match(tokTypes.braceL)
          case 'TupleElementTypes':
            return this.match(tokTypes.bracketR)
          case 'TypeParametersOrArguments':
            return this.match(tokTypes.relational)
        }

        throw new Error('Unreachable')
      }

      /**
       * If !expectSuccess, returns undefined instead of failing to parse.
       * If expectSuccess, parseElement should always return a defined value.
       */
      tsParseDelimitedListWorker<T extends Node>(
        kind: any,
        parseElement: () => T | undefined | null,
        expectSuccess: boolean,
        refTrailingCommaPos?: {
          value: number;
        }
      ): T[] | undefined | null {
        const result = []
        let trailingCommaPos = -1

        for (; ;) {
          if (this.tsIsListTerminator(kind)) {
            break
          }
          trailingCommaPos = -1

          const element = parseElement()
          if (element == null) {
            return undefined
          }
          result.push(element)

          if (this.eat(tokTypes.comma)) {
            trailingCommaPos = this.lastTokStart
            continue
          }

          if (this.tsIsListTerminator(kind)) {
            break
          }

          if (expectSuccess) {
            // This will fail with an error about a missing comma
            this.expect(tokTypes.comma)
          }
          return undefined
        }

        if (refTrailingCommaPos) {
          refTrailingCommaPos.value = trailingCommaPos
        }

        return result
      }

      tsParseDelimitedList<T extends Node>(
        kind: any,
        parseElement: () => T,
        refTrailingCommaPos?: {
          value: number;
        }
      ): T[] {
        return nonNull(
          this.tsParseDelimitedListWorker(
            kind,
            parseElement,
            /* expectSuccess */ true,
            refTrailingCommaPos
          )
        )
      }

      tsParseBracketedList<T extends Node>(
        kind: any,
        parseElement: () => T,
        bracket: boolean,
        skipFirstToken: boolean,
        refTrailingCommaPos?: {
          value: number;
        }
      ): T[] {
        if (!skipFirstToken) {
          if (bracket) {
            this.expect(tokTypes.bracketL)
          } else {
            this.expect(tokTypes.relational)
          }
        }

        const result = this.tsParseDelimitedList(
          kind,
          parseElement,
          refTrailingCommaPos
        )

        if (bracket) {
          this.expect(tokTypes.bracketR)
        } else {
          this.expect(tokTypes.relational)
        }

        return result
      }

      tsParseTypeParameterName(): Identifier | string {
        const typeName = this.parseIdent()
        return typeName.name
      }

      tsEatThenParseType(token: TokenType): Node | typeof undefined {
        return !this.match(token) ? undefined : this.tsNextThenParseType()
      }

      tsExpectThenParseType(token: TokenType): Node {
        return this.tsDoThenParseType(() => this.expect(token))
      }

      tsNextThenParseType(): Node {
        return this.tsDoThenParseType(() => this.next())
      }

      tsDoThenParseType(cb: () => void): Node {
        return this.tsInType(() => {
          cb()
          return this.tsParseType()
        })
      }

      tsSkipParameterStart(): boolean {
        if (tokenIsIdentifier(this.type) || this.match(tokTypes._this)) {
          this.next()
          return true
        }

        if (this.match(tokTypes.braceL)) {
          // Return true if we can parse an object pattern without errors
          try {
            this.parseObj(true)
            return true
          } catch {
            return false
          }
        }

        if (this.match(tokTypes.bracketL)) {
          this.next()
          try {
            this.parseBindingList(
              tokTypes.bracketR,
              true,
              true
            )
            return true
          } catch {
            return false
          }
        }

        return false
      }

      tsIsUnambiguouslyStartOfFunctionType(): boolean {
        this.next()
        if (this.match(tokTypes.parenR) || this.match(tokTypes.ellipsis)) {
          // ( )
          // ( ...
          return true
        }
        if (this.tsSkipParameterStart()) {
          if (
            this.match(tokTypes.colon) ||
            this.match(tokTypes.comma) ||
            this.match(tokTypes.question) ||
            this.match(tokTypes.eq)
          ) {
            // ( xxx :
            // ( xxx ,
            // ( xxx ?
            // ( xxx =
            return true
          }
          if (this.match(tokTypes.parenR)) {
            this.next()
            if (this.match(tokTypes.arrow)) {
              // ( xxx ) =>
              return true
            }
          }
        }
        return false
      }

      tsIsStartOfFunctionType() {
        if (this.match(tokTypes.relational)) {
          return true
        }
        return (
          this.match(tokTypes.parenL) &&
          this.tsLookAhead(this.tsIsUnambiguouslyStartOfFunctionType.bind(this))
        )
      }

      tsInAllowConditionalTypesContext<T>(cb: () => T): T {
        const oldInDisallowConditionalTypesContext =
          this.inDisallowConditionalTypesContext
        this.inDisallowConditionalTypesContext = false
        try {
          return cb()
        } finally {
          this.inDisallowConditionalTypesContext =
            oldInDisallowConditionalTypesContext
        }
      }

      tsParseBindingListForSignature(): Array<Identifier | RestElement | ObjectPattern | ArrayPattern> {
        return super
          .parseBindingList(tokTypes.parenR, true, true)
          .map(pattern => {
            if (
              pattern.type !== 'Identifier' &&
              pattern.type !== 'RestElement' &&
              pattern.type !== 'ObjectPattern' &&
              pattern.type !== 'ArrayPattern'
            ) {
              this.raise(pattern.loc.start, TSErrors.UnsupportedSignatureParameterKind(pattern.type))
            }
            return pattern as any
          })
      }

      tsParseTypePredicateAsserts(): boolean {
        if (this.type !== tsTokenType.asserts) {
          return false
        }
        const containsEsc = this.containsEsc
        this.next()
        if (!tokenIsIdentifier(this.type) && !this.match(tokTypes._this)) {
          return false
        }

        if (containsEsc) {
          this.raise(this.lastTokStart, 'Escape sequence in keyword'
            + ' asserts')
        }

        return true
      }

      tsParseThisTypeNode() {
        const node = this.startNode()
        this.next()
        return this.finishNode(node, 'TSThisType')
      }

      tsParseTypeAnnotation(
        eatColon = true,
        t: Node = this.startNode()
      ): Node {
        this.tsInType(() => {
          if (eatColon) this.expect(tokTypes.colon)
          t.typeAnnotation = this.tsParseType()
        })
        return this.finishNode(t, 'TSTypeAnnotation')
      }

      tsParseThisTypePredicate(lhs: any) {
        this.next()
        const node = this.startNodeAtNode(lhs)
        node.parameterName = lhs
        node.typeAnnotation = this.tsParseTypeAnnotation(/* eatColon */ false)
        node.asserts = false
        return this.finishNode(node, 'TSTypePredicate')
      }

      tsParseThisTypeOrThisTypePredicate(): Node {
        const thisKeyword = this.tsParseThisTypeNode()
        if (this.ts_isContextual(tsTokenType.is) && !this.hasPrecedingLineBreak()) {
          return this.tsParseThisTypePredicate(thisKeyword)
        } else {
          return thisKeyword
        }
      }

      tsParseTypePredicatePrefix(): Identifier | undefined | null {
        const id = this.parseIdent()
        if (this.ts_isContextual(tsTokenType.is) && !this.hasPrecedingLineBreak()) {
          this.next()
          return id
        }
      }

      tsParseTypeOrTypePredicateAnnotation(
        returnToken: TokenType
      ): Node {
        return this.tsInType(() => {
          const t = this.startNode()
          this.expect(returnToken)

          const node = this.startNode()

          const asserts = !!this.tsTryParse(
            this.tsParseTypePredicateAsserts.bind(this)
          )

          if (asserts && this.match(tokTypes._this)) {
            // When asserts is false, thisKeyword is handled by tsParseNonArrayType
            // : asserts this is type
            let thisTypePredicate = this.tsParseThisTypeOrThisTypePredicate()
            // if it turns out to be a `TSThisType`, wrap it with `TSTypePredicate`
            // : asserts this
            if (thisTypePredicate.type === 'TSThisType') {
              node.parameterName = thisTypePredicate
              node.asserts = true
              node.typeAnnotation = null
              thisTypePredicate = this.finishNode(node, 'TSTypePredicate')
            } else {
              this.resetStartLocationFromNode(thisTypePredicate, node)
              thisTypePredicate.asserts = true
            }
            t.typeAnnotation = thisTypePredicate
            return this.finishNode(t, 'TSTypeAnnotation')
          }

          const typePredicateVariable =
            this.tsIsIdentifier() &&
            this.tsTryParse(this.tsParseTypePredicatePrefix.bind(this))

          if (!typePredicateVariable) {
            if (!asserts) {
              // : type
              return this.tsParseTypeAnnotation(/* eatColon */ false, t)
            }

            // : asserts foo
            node.parameterName = this.parseIdent()
            node.asserts = asserts
            node.typeAnnotation = null
            t.typeAnnotation = this.finishNode(node, 'TSTypePredicate')
            return this.finishNode(t, 'TSTypeAnnotation')
          }

          // : asserts foo is type
          const type = this.tsParseTypeAnnotation(/* eatColon */ false)
          node.parameterName = typePredicateVariable
          node.typeAnnotation = type
          node.asserts = asserts
          t.typeAnnotation = this.finishNode(node, 'TSTypePredicate')
          return this.finishNode(t, 'TSTypeAnnotation')
        })
      }

      // Note: In TypeScript implementation we must provide `yieldContext` and `awaitContext`,
      // but here it's always false, because this is only used for types.
      tsFillSignature(
        returnToken: TokenType,
        signature: Node
      ): void {
        // Arrow fns *must* have return token (`=>`). Normal functions can omit it.
        const returnTokenRequired = returnToken === tokTypes.arrow

        // https://github.com/babel/babel/issues/9231
        const paramsKey = 'parameters'
        const returnTypeKey = 'typeAnnotation'

        signature.typeParameters = this.tsTryParseTypeParameters()
        this.expect(tokTypes.parenL)
        signature[paramsKey] = this.tsParseBindingListForSignature()
        if (returnTokenRequired) {
          signature[returnTypeKey] =
            this.tsParseTypeOrTypePredicateAnnotation(returnToken)
        } else if (this.match(returnToken)) {
          signature[returnTypeKey] =
            this.tsParseTypeOrTypePredicateAnnotation(returnToken)
        }
      }

      tsTryNextParseConstantContext(): Node | undefined | null {
        if (this.lookahead().type !== tokTypes._const) return null

        this.next()
        const typeReference = this.tsParseTypeReference()

        // If the type reference has type parameters, then you are using it as a
        // type and not as a const signifier. We'll *never* be able to find this
        // name, since const isn't allowed as a type name. So in this instance we
        // get to pretend we're the type checker.
        if (typeReference.typeParameters) {
          this.raise(typeReference.typeName.start, TSErrors.CannotFindName({
            name: 'const'
          }))
        }

        return typeReference
      }

      tsParseFunctionOrConstructorType(
        type: 'TSFunctionType' | 'TSConstructorType',
        abstract?: boolean
      ) {
        const node = this.startNode()
        if (type === 'TSConstructorType') {
          node.abstract = !!abstract
          if (abstract) this.next()
          this.next() // eat `new`
        }
        this.tsInAllowConditionalTypesContext(() =>
          this.tsFillSignature(tokTypes.arrow, node)
        )
        return this.finishNode(node, type)
      }

      tsParseUnionOrIntersectionType(
        kind: 'TSUnionType' | 'TSIntersectionType',
        parseConstituentType: () => Node,
        operator: TokenType
      ): Node {
        const node = this.startNode()
        const hasLeadingOperator = this.eat(operator)
        const types = []
        do {
          types.push(parseConstituentType())
        } while (this.eat(operator))
        if (types.length === 1 && !hasLeadingOperator) {
          return types[0]
        }
        node.types = types
        return this.finishNode(node, kind)
      }

      tsCheckTypeAnnotationForReadOnly(node: Node) {
        switch (node.typeAnnotation.type) {
          case 'TSTupleType':
          case 'TSArrayType':
            return
          default:
            this.raise(node.loc.start, TSErrors.UnexpectedReadonly)
        }
      }

      tsParseTypeOperator(): Node {
        const node = this.startNode()
        const operator = this.value
        this.next() // eat operator
        node.operator = operator
        node.typeAnnotation = this.tsParseTypeOperatorOrHigher()

        if (operator === 'readonly') {
          this.tsCheckTypeAnnotationForReadOnly(
            // @ts-expect-error todo(flow->ts)
            node
          )
        }

        return this.finishNode(node, 'TSTypeOperator')
      }

      tsParseConstraintForInferType() {
        if (this.eat(tokTypes._extends)) {
          const constraint = this.tsInDisallowConditionalTypesContext(() =>
            this.tsParseType()
          )
          if (
            this.inDisallowConditionalTypesContext ||
            !this.match(tokTypes.question)
          ) {
            return constraint
          }
        }
      }

      tsParseInferType(): Node {
        const node = this.startNode()
        this.expectContextual('infer')
        const typeParameter = this.startNode()
        typeParameter.name = this.tsParseTypeParameterName()
        typeParameter.constraint = this.tsTryParse(() =>
          this.tsParseConstraintForInferType()
        )
        node.typeParameter = this.finishNode(typeParameter, 'TSTypeParameter')
        return this.finishNode(node, 'TSInferType')
      }

      tsParseLiteralTypeNode(): Node {
        const node = this.startNode()
        // @ts-expect-error refine typings
        node.literal = (() => {
          switch (this.type) {
            case tokTypes.num:
            // we don't need bigint type here
            // case tokTypes.bigint:
            case tokTypes.string:
            case tokTypes._true:
            case tokTypes._false:
              // For compatibility to estree we cannot call parseLiteral directly here
              return this.parseExprAtom()
            default:
              this.unexpected()
          }
        })()
        return this.finishNode(node, 'TSLiteralType')
      }

      tsParseImportType(): Node {
        const node = this.startNode()
        this.expect(tokTypes._import)
        this.expect(tokTypes.parenL)
        if (!this.match(tokTypes.string)) {
          this.raise(this.start, TSErrors.UnsupportedImportTypeArgument)
        }

        // For compatibility to estree we cannot call parseLiteral directly here
        node.argument = this.parseExprAtom()
        this.expect(tokTypes.parenR)

        if (this.eat(tokTypes.dot)) {
          // In this instance, the entity name will actually itself be a
          // qualifier, so allow it to be a reserved word as well.
          node.qualifier = this.tsParseEntityName()
        }
        if (this.match(tokTypes.relational)) {
          node.typeParameters = this.tsParseTypeArguments()
        }
        return this.finishNode(node, 'TSImportType')
      }

      tsParseTypeQuery(): Node {
        const node = this.startNode()
        this.expect(tokTypes._typeof)
        if (this.match(tokTypes._import)) {
          node.exprName = this.tsParseImportType()
        } else {
          node.exprName = this.tsParseEntityName()
        }
        if (!this.hasPrecedingLineBreak() && this.match(tokTypes.relational)) {
          node.typeParameters = this.tsParseTypeArguments()
        }
        return this.finishNode(node, 'TSTypeQuery')
      }

      tsParseMappedTypeParameter(): Node {
        const node = this.startNode()
        node.name = this.tsParseTypeParameterName()
        node.constraint = this.tsExpectThenParseType(tokTypes._in)
        return this.finishNode(node, 'TSTypeParameter')
      }

      tsParseMappedType(): Node {
        const node = this.startNode()

        this.expect(tokTypes.braceL)

        if (this.match(tokTypes.plusMin)) {
          node.readonly = this.value
          this.next()
          this.expectContextual('readonly')
        } else if (this.eatContextual('readonly')) {
          node.readonly = true
        }

        this.expect(tokTypes.bracketL)
        node.typeParameter = this.tsParseMappedTypeParameter()
        node.nameType = this.eatContextual('as') ? this.tsParseType() : null

        this.expect(tokTypes.bracketR)

        if (this.match(tokTypes.plusMin)) {
          node.optional = this.value
          this.next()
          this.expect(tokTypes.question)
        } else if (this.eat(tokTypes.question)) {
          node.optional = true
        }

        node.typeAnnotation = this.tsTryParseType()
        this.semicolon()
        this.expect(tokTypes.braceR)

        return this.finishNode(node, 'TSMappedType')
      }

      tsParseTypeLiteral(): Node {
        const node = this.startNode()
        node.members = this.tsParseObjectTypeMembers()
        return this.finishNode(node, 'TSTypeLiteral')
      }

      tsParseTupleElementType(): Node {
        // parses `...TsType[]`

        const { start: startPos, startLoc } = this

        const rest = this.eat(tokTypes.ellipsis)
        let type: any = this.tsParseType()
        const optional = this.eat(tokTypes.question)
        const labeled = this.eat(tokTypes.colon)

        if (labeled) {
          const labeledNode = this.startNodeAtNode(type)
          labeledNode.optional = optional

          if (
            type.type === 'TSTypeReference' &&
            !type.typeParameters &&
            type.typeName.type === 'Identifier'
          ) {
            labeledNode.label = type.typeName as Identifier
          } else {
            this.raise(type.start, TSErrors.InvalidTupleMemberLabel)
            // @ts-expect-error This produces an invalid AST, but at least we don't drop
            // nodes representing the invalid source.
            labeledNode.label = type
          }

          labeledNode.elementType = this.tsParseType()
          type = this.finishNode(labeledNode, 'TSNamedTupleMember')
        } else if (optional) {
          const optionalTypeNode = this.startNodeAtNode<N.TsOptionalType>(type)
          optionalTypeNode.typeAnnotation = type
          type = this.finishNode(optionalTypeNode, 'TSOptionalType')
        }

        if (rest) {
          const restNode = this.startNodeAt(startPos, startLoc)
          restNode.typeAnnotation = type
          type = this.finishNode(restNode, 'TSRestType')
        }

        return type
      }

      tsParseTupleType(): Node {
        const node = this.startNode()
        node.elementTypes = this.tsParseBracketedList(
          'TupleElementTypes',
          this.tsParseTupleElementType.bind(this),
          /* bracket */ true,
          /* skipFirstToken */ false
        )

        // Validate the elementTypes to ensure that no mandatory elements
        // follow optional elements
        let seenOptionalElement = false
        let labeledElements: boolean | null = null
        node.elementTypes.forEach(elementNode => {
          const { type } = elementNode

          if (
            seenOptionalElement &&
            type !== 'TSRestType' &&
            type !== 'TSOptionalType' &&
            !(type === 'TSNamedTupleMember' && elementNode.optional)
          ) {
            this.raise(elementNode.start, TSErrors.OptionalTypeBeforeRequired)
          }

          seenOptionalElement ||=
            (type === 'TSNamedTupleMember' && elementNode.optional) ||
            type === 'TSOptionalType'

          // When checking labels, check the argument of the spread operator
          let checkType = type
          if (type === 'TSRestType') {
            elementNode = elementNode.typeAnnotation
            checkType = elementNode.type
          }

          const isLabeled = checkType === 'TSNamedTupleMember'
          labeledElements ??= isLabeled
          if (labeledElements !== isLabeled) {
            this.raise(elementNode.start, TSErrors.MixedLabeledAndUnlabeledElements)
          }
        })

        return this.finishNode(node, 'TSTupleType')
      }

      tsParseTemplateLiteralType(): Node {
        const node = this.startNode()
        node.literal = this.parseTemplate({ isTagged: false })
        return this.finishNode(node, 'TSLiteralType')
      }

      tsParseTypeReference(): Node {
        const node = this.startNode()
        node.typeName = this.tsParseEntityName()
        if (!this.hasPrecedingLineBreak() && this.match(tokTypes.relational)) {
          node.typeParameters = this.tsParseTypeArguments()
        }
        return this.finishNode(node, 'TSTypeReference')
      }

      tsParseParenthesizedType(): N.TsParenthesizedType {
        const node = this.startNode()
        this.expect(tokTypes.parenL)
        node.typeAnnotation = this.tsParseType()
        this.expect(tokTypes.parenR)
        return this.finishNode(node, 'TSParenthesizedType')
      }

      tsParseNonArrayType(): Node {
        switch (this.type) {
          case tokTypes.string:
          case tokTypes.num:
          // we don't need bigint type here
          // case tokTypes.bigint:
          case tokTypes._true:
          case tokTypes._false:
            return this.tsParseLiteralTypeNode()
          case tokTypes.plusMin:
            if (this.value === '-') {
              const node = this.startNode()
              const nextToken = this.lookahead()
              if (
                nextToken.type !== tokTypes.num
                // && nextToken.type !== tsTokenType.bigint
              ) {
                this.unexpected()
              }
              // @ts-expect-error: parseMaybeUnary must returns unary expression
              node.literal = this.parseMaybeUnary()
              return this.finishNode(node, 'TSLiteralType')
            }
            break
          case tokTypes._this:
            return this.tsParseThisTypeOrThisTypePredicate()
          case tokTypes._typeof:
            return this.tsParseTypeQuery()
          case tokTypes._import:
            return this.tsParseImportType()
          case tokTypes.braceL:
            return this.tsLookAhead(this.tsIsStartOfMappedType.bind(this))
              ? this.tsParseMappedType()
              : this.tsParseTypeLiteral()
          case tokTypes.bracketL:
            return this.tsParseTupleType()
          case tokTypes.parenL:
            // the following line will always be false
            // if (!this.options.createParenthesizedExpressions) {
            // const startPos = this.start
            // this.next()
            // const type = this.tsParseType()
            // this.expect(tokTypes.parenR)
            // this.addExtra(type, 'parenthesized', true)
            // this.addExtra(type, 'parenStart', startPos)
            // return type
            // }

            return this.tsParseParenthesizedType()
          // parse template string here
          case tokTypes.backQuote:
          case tokTypes.dollarBraceL:
            return this.tsParseTemplateLiteralType()
          default: {
            const { type } = this
            if (
              tokenIsIdentifier(type) ||
              type === tokTypes._void ||
              type === tokTypes._null
            ) {
              const nodeType =
                type === tokTypes._void
                  ? 'TSVoidKeyword'
                  : type === tokTypes._null
                    ? 'TSNullKeyword'
                    : keywordTypeFromName(this.value)
              if (
                nodeType !== undefined &&
                this.lookaheadCharCode() !== charCodes.dot
              ) {
                const node = this.startNode()
                this.next()
                return this.finishNode(node, nodeType)
              }
              return this.tsParseTypeReference()
            }
          }
        }

        this.unexpected()
      }

      tsParseArrayTypeOrHigher(): Node {
        let type = this.tsParseNonArrayType()
        while (!this.hasPrecedingLineBreak() && this.eat(tokTypes.bracketL)) {
          if (this.match(tokTypes.bracketR)) {
            const node = this.startNodeAtNode(type)
            node.elementType = type
            this.expect(tokTypes.bracketR)
            type = this.finishNode(node, 'TSArrayType')
          } else {
            const node = this.startNodeAtNode(type)
            node.objectType = type
            node.indexType = this.tsParseType()
            this.expect(tokTypes.bracketR)
            type = this.finishNode(node, 'TSIndexedAccessType')
          }
        }
        return type
      }

      tsParseTypeOperatorOrHigher(): Node {
        const isTypeOperator =
          tokenIsTSTypeOperator(this.type) && !this.containsEsc
        return isTypeOperator
          ? this.tsParseTypeOperator()
          : this.ts_isContextual(tsTokenType.infer)
            ? this.tsParseInferType()
            : this.tsInAllowConditionalTypesContext(() =>
              this.tsParseArrayTypeOrHigher()
            )
      }

      tsParseIntersectionTypeOrHigher(): N.TsType {
        return this.tsParseUnionOrIntersectionType(
          'TSIntersectionType',
          this.tsParseTypeOperatorOrHigher.bind(this),
          tokTypes.bitwiseAND
        )
      }

      tsParseUnionTypeOrHigher() {
        return this.tsParseUnionOrIntersectionType(
          'TSUnionType',
          this.tsParseIntersectionTypeOrHigher.bind(this),
          tokTypes.bitwiseOR
        )
      }

      tsParseNonConditionalType(): Node {
        if (this.tsIsStartOfFunctionType()) {
          return this.tsParseFunctionOrConstructorType('TSFunctionType')
        }
        if (this.match(tokTypes._new)) {
          // As in `new () => Date`
          return this.tsParseFunctionOrConstructorType('TSConstructorType')
        } else if (this.isAbstractConstructorSignature()) {
          // As in `abstract new () => Date`
          return this.tsParseFunctionOrConstructorType(
            'TSConstructorType',
            /* abstract */ true
          )
        }
        return this.tsParseUnionTypeOrHigher()
      }

      /** Be sure to be in a type context before calling this, using `tsInType`. */
      tsParseType(): Node {
        // Need to set `state.inType` so that we don't parse JSX in a type context.
        assert(this.inType)
        const type = this.tsParseNonConditionalType()

        if (
          this.inDisallowConditionalTypesContext ||
          this.hasPrecedingLineBreak() ||
          !this.eat(tokTypes._extends)
        ) {
          return type
        }
        const node = this.startNodeAtNode<N.TsConditionalType>(type)
        node.checkType = type

        node.extendsType = this.tsInDisallowConditionalTypesContext(() =>
          this.tsParseNonConditionalType()
        )

        this.expect(tokTypes.question)
        node.trueType = this.tsInAllowConditionalTypesContext(() =>
          this.tsParseType()
        )

        this.expect(tokTypes.colon)
        node.falseType = this.tsInAllowConditionalTypesContext(() =>
          this.tsParseType()
        )

        return this.finishNode(node, 'TSConditionalType')
      }

      tsIsUnambiguouslyIndexSignature() {
        this.next() // Skip '{'
        if (tokenIsIdentifier(this.type)) {
          this.next()
          return this.match(tokTypes.colon)
        }
        return false
      }

      /**
       * Runs `cb` in a type context.
       * This should be called one token *before* the first type token,
       * so that the call to `next()` is run in type context.
       */
      tsInType<T>(cb: () => T): T {
        const oldInType = this.inType
        this.inType = true
        try {
          return cb()
        } finally {
          this.inType = oldInType
        }
      }

      tsTryParseIndexSignature(
        node: Node
      ): Node | undefined | null {
        if (
          !(
            this.match(tokTypes.bracketL) &&
            this.tsLookAhead(this.tsIsUnambiguouslyIndexSignature.bind(this))
          )
        ) {
          return undefined
        }

        this.expect(tokTypes.bracketL)
        const id = this.parseIdent()
        id.typeAnnotation = this.tsParseTypeAnnotation()
        this.resetEndLocation(id) // set end position to end of type

        this.expect(tokTypes.bracketR)
        node.parameters = [id]

        const type = this.tsTryParseTypeAnnotation()
        if (type) node.typeAnnotation = type
        this.tsParseTypeMemberSemicolon()
        return this.finishNode(node, 'TSIndexSignature')
      }

      tsParseTypeParameter(
        parseModifiers: (
          node: Node
        ) => void = this.tsParseNoneModifiers.bind(this)
      ): Node {
        const node = this.startNode()

        parseModifiers(node)

        node.name = this.tsParseTypeParameterName()
        node.constraint = this.tsEatThenParseType(tokTypes._extends)
        node.default = this.tsEatThenParseType(tokTypes.eq)
        return this.finishNode(node, 'TSTypeParameter')
      }

      tsParseTypeParameters(
        parseModifiers?: ((node) => void) | null
      ) {
        const node = this.startNode()

        // todo support jsx
        if (this.match(tokTypes.relational) || this.match(jsxTokenType.jsxTagStart)) {
          this.next()
        } else {
          this.unexpected()
        }

        const refTrailingCommaPos = { value: -1 }

        node.params = this.tsParseBracketedList(
          'TypeParametersOrArguments',
          // @ts-expect-error refine typings
          this.tsParseTypeParameter.bind(this, parseModifiers),
          /* bracket */ false,
          /* skipFirstToken */ true,
          refTrailingCommaPos
        )
        if (node.params.length === 0) {
          this.raise(this.start, TSErrors.EmptyTypeParameters)
        }
        if (refTrailingCommaPos.value !== -1) {
          this.addExtra(node, 'trailingComma', refTrailingCommaPos.value)
        }
        return this.finishNode(node, 'TSTypeParameterDeclaration')
      }

      tsTryParseTypeParameters(
        parseModifiers?: ((node) => void) | null
      ) {
        if (this.match(tokTypes.relational)) {
          return this.tsParseTypeParameters(parseModifiers)
        }
      }

      tsTryParse<T>(f: () => T | undefined | false): T | undefined {
        const state = this.getCurLookaheadState()
        const result = f()
        if (result !== undefined && result !== false) {
          return result
        } else {
          this.setLookaheadState(state)
          return undefined
        }
      }

      tsTokenCanFollowModifier() {
        return (
          (this.match(tokTypes.bracketL) ||
            this.match(tokTypes.braceL) ||
            this.match(tokTypes.star) ||
            this.match(tokTypes.ellipsis) ||
            this.match(tokTypes.privateId) ||
            this.isLiteralPropertyName()) &&
          !this.hasPrecedingLineBreak()
        )
      }

      tsNextTokenCanFollowModifier() {
        // Note: TypeScript's implementation is much more complicated because
        // more things are considered modifiers there.
        // This implementation only handles modifiers not handled by @babel/parser itself. And "static".
        // TODO: Would be nice to avoid lookahead. Want a hasLineBreakUpNext() method...
        this.next()
        return this.tsTokenCanFollowModifier()
      }

      /** Parses a modifier matching one the given modifier names. */
      tsParseModifier<T extends TsModifier>(
        allowedModifiers: T[],
        stopOnStartOfClassStaticBlock?: boolean
      ): T | undefined | null {
        if (!tokenIsIdentifier(this.type) && this.type !== tokTypes._in) {
          return undefined
        }

        const modifier = this.value
        if (allowedModifiers.indexOf(modifier) !== -1) {
          if (stopOnStartOfClassStaticBlock && this.tsIsStartOfStaticBlocks()) {
            return undefined
          }
          if (this.tsTryParse(this.tsNextTokenCanFollowModifier.bind(this))) {
            return modifier
          }
        }
        return undefined
      }

      /** Parses a list of modifiers, in any order.
       *  If you need a specific order, you must call this function multiple times:
       *    this.tsParseModifiers({ modified: node, allowedModifiers: ['public'] });
       *    this.tsParseModifiers({ modified: node, allowedModifiers: ["abstract", "readonly"] });
       */
      tsParseModifiers({
        modified,
        allowedModifiers,
        disallowedModifiers,
        stopOnStartOfClassStaticBlock,
        errorTemplate = TSErrors.InvalidModifierOnTypeMember
      }: {
        modified: ModifierBase;
        allowedModifiers: readonly TsModifier[];
        disallowedModifiers?: TsModifier[];
        stopOnStartOfClassStaticBlock?: boolean;
        // FIXME: make sure errorTemplate can receive `modifier`
        errorTemplate?: any;
      }): void {
        const enforceOrder = (
          loc: Position,
          modifier: TsModifier,
          before: TsModifier,
          after: TsModifier
        ) => {
          if (modifier === before && modified[after]) {
            this.raise(this.start, TSErrors.InvalidModifiersOrder)
          }
        }
        const incompatible = (
          loc: Position,
          modifier: TsModifier,
          mod1: TsModifier,
          mod2: TsModifier
        ) => {
          if (
            (modified[mod1] && modifier === mod2) ||
            (modified[mod2] && modifier === mod1)
          ) {
            this.raise(this.start, TSErrors.IncompatibleModifiers)
          }
        }

        for (; ;) {
          const { startLoc } = this
          const modifier: TsModifier | undefined | null = this.tsParseModifier(
            allowedModifiers.concat(disallowedModifiers ?? []),
            stopOnStartOfClassStaticBlock
          )

          if (!modifier) break

          if (tsIsAccessModifier(modifier)) {
            if (modified.accessibility) {
              this.raise(this.start, TSErrors.DuplicateAccessibilityModifier)
            } else {
              enforceOrder(startLoc, modifier, modifier, 'override')
              enforceOrder(startLoc, modifier, modifier, 'static')
              enforceOrder(startLoc, modifier, modifier, 'readonly')

              modified.accessibility = modifier
            }
          } else if (tsIsVarianceAnnotations(modifier)) {
            if (modified[modifier]) {
              this.raise(this.start, TSErrors.DuplicateModifier)
            }
            modified[modifier] = true

            enforceOrder(startLoc, modifier, 'in', 'out')
          } else {
            if (Object.hasOwnProperty.call(modified, modifier)) {
              this.raise(this.start, TSErrors.DuplicateModifier)
            } else {
              enforceOrder(startLoc, modifier, 'static', 'readonly')
              enforceOrder(startLoc, modifier, 'static', 'override')
              enforceOrder(startLoc, modifier, 'override', 'readonly')
              enforceOrder(startLoc, modifier, 'abstract', 'override')

              incompatible(startLoc, modifier, 'declare', 'override')
              incompatible(startLoc, modifier, 'static', 'abstract')
            }
            modified[modifier] = true
          }

          if (disallowedModifiers?.includes(modifier)) {
            this.raise(this.start, errorTemplate)
          }
        }
      }

      tsParseInOutModifiers(node: Node) {
        this.tsParseModifiers({
          modified: node,
          allowedModifiers: ['in', 'out'],
          disallowedModifiers: [
            'public',
            'private',
            'protected',
            'readonly',
            'declare',
            'abstract',
            'override'
          ],
          errorTemplate: TSErrors.InvalidModifierOnTypeParameter
        })
      }

      tsParseTypeArguments(): Node {
        const node = this.startNode()
        node.params = this.tsInType(() =>
          // Temporarily remove a JSX parsing context, which makes us scan different tokens.
          this.tsInNoContext(() => {
            this.expect(tokTypes.relational)
            return this.tsParseDelimitedList(
              'TypeParametersOrArguments',
              this.tsParseType.bind(this)
            )
          })
        )
        if (node.params.length === 0) {
          this.raise(this.start, TSErrors.EmptyTypeArguments)
        }
        this.expect(tokTypes.relational)
        return this.finishNode(node, 'TSTypeParameterInstantiation')
      }

      tsParseHeritageClause(
        token: 'extends' | 'implements'
      ): Array<Node> {
        const originalStart = this.start

        const delimitedList = this.tsParseDelimitedList(
          'HeritageClauseElement',
          () => {
            const node = this.startNode()
            node.expression = this.tsParseEntityName()
            if (this.match(tokTypes.relational)) {
              node.typeParameters = this.tsParseTypeArguments()
            }

            return this.finishNode(node, 'TSExpressionWithTypeArguments')
          }
        )

        if (!delimitedList.length) {
          this.raise(originalStart, TSErrors.EmptyHeritageClauseType(token))
        }

        return delimitedList
      }

      tsParseTypeMemberSemicolon(): void {
        if (!this.eat(tokTypes.comma) && !this.isLineTerminator()) {
          this.expect(tokTypes.semi)
        }
      }

      tsTryParseAndCatch<T extends BaseNode | undefined | null>(
        f: () => T
      ): T | undefined | null {
        const result = this.tryParse(
          abort =>
            // @ts-expect-error todo(flow->ts)
            f() || abort()
        )

        if (result.aborted || !result.node) return undefined
        if (result.error) this.setLookaheadState(result.failState)
        // @ts-expect-error refine typings
        return result.node
      }

      tsParseSignatureMember(
        kind: 'TSCallSignatureDeclaration' | 'TSConstructSignatureDeclaration',
        node: Node
      ): Node {
        this.tsFillSignature(tokTypes.colon, node)
        this.tsParseTypeMemberSemicolon()
        return this.finishNode(node, kind)
      }

      tsParsePropertyOrMethodSignature(
        node: Node,
        readonly: boolean
      ): Node {
        if (this.eat(tokTypes.question)) node.optional = true
        const nodeAny: any = node

        if (this.match(tokTypes.parenL) || this.match(tokTypes.relational)) {
          if (readonly) {
            this.raise(node.start, TSErrors.ReadonlyForMethodSignature)
          }
          const method = nodeAny
          if (method.kind && this.match(tokTypes.relational)) {
            this.raise(this.start, TSErrors.AccesorCannotHaveTypeParameters)
          }
          this.tsFillSignature(tokTypes.colon, method)
          this.tsParseTypeMemberSemicolon()
          const paramsKey = 'parameters'
          const returnTypeKey = 'typeAnnotation'
          if (method.kind === 'get') {
            if (method[paramsKey].length > 0) {
              this.raise(this.start, 'A \'get\' accesor must not have any formal parameters.')
              if (this.isThisParam(method[paramsKey][0])) {
                this.raise(this.start, TSErrors.AccesorCannotDeclareThisParameter)
              }
            }
          } else if (method.kind === 'set') {
            if (method[paramsKey].length !== 1) {
              this.raise(this.start, 'A \'get\' accesor must'
                + ' not have any formal parameters.')
            } else {
              const firstParameter = method[paramsKey][0]
              if (this.isThisParam(firstParameter)) {
                this.raise(this.start, TSErrors.AccesorCannotDeclareThisParameter)
              }
              if (
                firstParameter.type === 'Identifier' &&
                firstParameter.optional
              ) {
                this.raise(this.start, TSErrors.SetAccesorCannotHaveOptionalParameter)
              }
              if (firstParameter.type === 'RestElement') {
                this.raise(this.start, TSErrors.SetAccesorCannotHaveRestParameter)
              }
            }
            if (method[returnTypeKey]) {
              this.raise(method[returnTypeKey].start, TSErrors.SetAccesorCannotHaveReturnType)
            }
          } else {
            method.kind = 'method'
          }
          return this.finishNode(method, 'TSMethodSignature')
        } else {
          const property = nodeAny
          if (readonly) property.readonly = true
          const type = this.tsTryParseTypeAnnotation()
          if (type) property.typeAnnotation = type
          this.tsParseTypeMemberSemicolon()
          return this.finishNode(property, 'TSPropertySignature')
        }
      }

      tsParseTypeMember(): Node {
        const node: any = this.startNode()

        if (this.match(tokTypes.parenL) || this.match(tokTypes.relational)) {
          return this.tsParseSignatureMember('TSCallSignatureDeclaration', node)
        }

        if (this.match(tokTypes._new)) {
          const id = this.startNode<Identifier>()
          this.next()
          if (this.match(tokTypes.parenL) || this.match(tokTypes.relational)) {
            return this.tsParseSignatureMember(
              'TSConstructSignatureDeclaration',
              node
            )
          } else {
            node.key = this.createIdentifier(id, 'new')
            return this.tsParsePropertyOrMethodSignature(node, false)
          }
        }

        this.tsParseModifiers({
          modified: node,
          allowedModifiers: ['readonly'],
          disallowedModifiers: [
            'declare',
            'abstract',
            'private',
            'protected',
            'public',
            'static',
            'override'
          ]
        })

        const idx = this.tsTryParseIndexSignature(node)
        if (idx) {
          return idx
        }

        this.parsePropertyName(node)
        if (
          !node.computed &&
          node.key.type === 'Identifier' &&
          (node.key.name === 'get' || node.key.name === 'set') &&
          this.tsTokenCanFollowModifier()
        ) {
          node.kind = node.key.name
          this.parsePropertyName(node)
        }
        return this.tsParsePropertyOrMethodSignature(node, !!node.readonly)
      }

      tsParseList<T extends N.Node>(
        kind: ParsingContext,
        parseElement: () => T
      ): T[] {
        const result: T[] = []
        while (!this.tsIsListTerminator(kind)) {
          // Skipping "parseListElement" from the TS source since that's just for error handling.
          result.push(parseElement())
        }
        return result
      }

      tsParseObjectTypeMembers(): Array<Node> {
        this.expect(tokTypes.braceL)
        const members = this.tsParseList(
          'TypeMembers',
          this.tsParseTypeMember.bind(this)
        )
        this.expect(tokTypes.braceR)
        return members
      }

      tsParseInterfaceDeclaration(
        node: Undone<N.TsInterfaceDeclaration>,
        properties: {
          declare?: true;
        } = {}
      ): N.TsInterfaceDeclaration | undefined | null {
        if (this.hasFollowingLineBreak()) return null
        this.expectContextual('interface')
        if (properties.declare) node.declare = true
        if (tokenIsIdentifier(this.type)) {
          node.id = this.parseIdent()
          this.checkLValSimple(node.id, BIND_TS_INTERFACE)
        } else {
          node.id = null
          this.raise(this.start, TSErrors.MissingInterfaceName)
        }

        node.typeParameters = this.tsTryParseTypeParameters(
          this.tsParseInOutModifiers.bind(this)
        )
        if (this.eat(tokTypes._extends)) {
          node.extends = this.tsParseHeritageClause('extends')
        }
        const body = this.startNode()
        body.body = this.tsInType(this.tsParseObjectTypeMembers.bind(this))
        node.body = this.finishNode(body, 'TSInterfaceBody')
        return this.finishNode(node, 'TSInterfaceDeclaration')
      }

      tsParseAbstractDeclaration(
        node: any
      ): Node | undefined | null {
        if (this.match(tokTypes._class)) {
          node.abstract = true
          return this.parseClass(node, true)
        } else if (this.ts_isContextual(tsTokenType.interface)) {
          // for invalid abstract interface

          // To avoid
          //   abstract interface
          //   Foo {}
          if (!this.hasFollowingLineBreak()) {
            node.abstract = true
            return this.tsParseInterfaceDeclaration(
              node
            )
          }
        } else {
          this.unexpected(null, tokTypes._class)
        }
      }

      tsIsDeclarationStart(): boolean {
        return tokenIsTSDeclarationStart(this.type)
      }

      tsParseExpressionStatement(
        node,
        expr
      ) {
        switch (expr.name) {
          case 'declare': {
            const declaration = this.tsTryParseDeclare(node)
            if (declaration) {
              declaration.declare = true
              return declaration
            }
            break
          }
          case 'global':
            // `global { }` (with no `declare`) may appear inside an ambient module declaration.
            // Would like to use tsParseAmbientExternalModuleDeclaration here, but already ran past "global".
            if (this.match(tokTypes.braceL)) {
              super.enterScope(SCOPE_TS_MODULE)
              const mod = node
              mod.global = true
              mod.id = expr
              mod.body = this.tsParseModuleBlock()
              super.exitScope()
              return this.finishNode(mod, 'TSModuleDeclaration')
            }
            break

          default:
            return this.tsParseDeclaration(node, expr.name, /* next */ false)
        }
      }

      tsParseModuleReference(): N.TsModuleReference {
        return this.tsIsExternalModuleReference()
          ? this.tsParseExternalModuleReference()
          : this.tsParseEntityName(/* allowReservedWords */ false)
      }

      tsIsExportDefaultSpecifier(): boolean {
        const { type } = this
        const isAsync = this.isAsyncFunction()
        const isLet = this.isLet()
        if (tokenIsIdentifier(type)) {
          if ((isAsync && !this.containsEsc) || isLet) {
            return false
          }
          if (
            (type === tsTokenType.type || type === tsTokenType.interface) &&
            !this.containsEsc
          ) {
            const { type: nextType } = this.lookahead()
            // If we see any variable name other than `from` after `type` keyword,
            // we consider it as flow/typescript type exports
            // note that this approach may fail on some pedantic cases
            // export type from = number
            if (
              (tokenIsIdentifier(nextType) && nextType !== tsTokenType.from) ||
              nextType === tokTypes.braceL
            ) {
              return false
            }
          }
        } else if (!this.match(tokTypes._default)) {
          return false
        }

        const next = this.nextTokenStart()
        const hasFrom = this.isUnparsedContextual(next, 'from')
        if (
          this.input.charCodeAt(next) === charCodes.comma ||
          (tokenIsIdentifier(this.type) && hasFrom)
        ) {
          return true
        }
        // lookahead again when `export default from` is seen
        if (this.match(tokTypes._default) && hasFrom) {
          const nextAfterFrom = this.input.charCodeAt(
            this.nextTokenStartSince(next + 4)
          )
          return (
            nextAfterFrom === charCodes.quotationMark ||
            nextAfterFrom === charCodes.apostrophe
          )
        }
        return false
      }

      tsInAmbientContext<T>(cb: () => T): T {
        const oldIsAmbientContext = this.isAmbientContext
        this.isAmbientContext = true
        try {
          return cb()
        } finally {
          this.isAmbientContext = oldIsAmbientContext
        }
      }

      tsCheckLineTerminator(next: boolean) {
        if (next) {
          if (this.hasFollowingLineBreak()) return false
          this.next()
          return true
        }
        return !this.isLineTerminator()
      }

      tsParseModuleOrNamespaceDeclaration(
        node: Node,
        nested: boolean = false
      ): Node {
        node.id = this.parseIdent()

        if (!nested) {
          this.checkLValSimple(node.id, BIND_TS_NAMESPACE)
        }

        if (this.eat(tokTypes.dot)) {
          const inner = this.startNode()
          this.tsParseModuleOrNamespaceDeclaration(inner, true)
          // @ts-expect-error Fixme: refine typings
          node.body = inner
        } else {
          super.enterScope(SCOPE_TS_MODULE)
          node.body = this.tsParseModuleBlock()
          super.exitScope()
        }
        return this.finishNode(node, 'TSModuleDeclaration')
      }

      tsParseTypeAliasDeclaration(
        node: Node
      ): Node {
        node.id = this.parseIdent()
        this.checkLValSimple(node.id, BIND_TS_TYPE)

        node.typeAnnotation = this.tsInType(() => {
          node.typeParameters = this.tsTryParseTypeParameters(
            this.tsParseInOutModifiers.bind(this)
          )

          this.expect(tokTypes.eq)

          if (
            this.ts_isContextual(tsTokenType.interface) &&
            this.lookahead().type !== tokTypes.dot
          ) {
            const node = this.startNode()
            this.next()
            return this.finishNode(node, 'TSIntrinsicKeyword')
          }

          return this.tsParseType()
        })

        this.semicolon()
        return this.finishNode(node, 'TSTypeAliasDeclaration')
      }

      // Common to tsTryParseDeclare, tsTryParseExportDeclaration, and tsParseExpressionStatement.
      tsParseDeclaration(
        node: any,
        value: string,
        next: boolean
      ): Declaration | undefined | null {
        // no declaration apart from enum can be followed by a line break.
        switch (value) {
          case 'abstract':
            if (
              this.tsCheckLineTerminator(next) &&
              (this.match(tokTypes._class) || tokenIsIdentifier(this.type))
            ) {
              return this.tsParseAbstractDeclaration(node)
            }
            break

          case 'module':
            if (this.tsCheckLineTerminator(next)) {
              if (this.match(tokTypes.string)) {
                return this.tsParseAmbientExternalModuleDeclaration(node)
              } else if (tokenIsIdentifier(this.type)) {
                return this.tsParseModuleOrNamespaceDeclaration(node)
              }
            }
            break

          case 'namespace':
            if (
              this.tsCheckLineTerminator(next) &&
              tokenIsIdentifier(this.type)
            ) {
              return this.tsParseModuleOrNamespaceDeclaration(node)
            }
            break

          case 'type':
            if (
              this.tsCheckLineTerminator(next) &&
              tokenIsIdentifier(this.type)
            ) {
              return this.tsParseTypeAliasDeclaration(node)
            }
            break
        }
      }

      // Note: this won't b·e called unless the keyword is allowed in
      // `shouldParseExportDeclaration`.
      tsTryParseExportDeclaration(): Declaration | undefined | null {
        return this.tsParseDeclaration(
          this.startNode(),
          this.value,
          /* next */ true
        )
      }

      tsParseImportEqualsDeclaration(
        node,
        isExport?: boolean
      ): Node {
        node.isExport = isExport || false
        node.id = this.parseIdent()
        this.checkLValSimple(node.id, BIND_LEXICAL)
        super.expect(tokTypes.eq)
        const moduleReference = this.tsParseModuleReference()
        if (
          node.importKind === 'type' &&
          moduleReference.type !== 'TSExternalModuleReference'
        ) {
          this.raise(moduleReference.start, TypeScriptError.ImportAliasHasImportType)
        }
        node.moduleReference = moduleReference
        super.semicolon()
        return this.finishNode(node, 'TSImportEqualsDeclaration')
      }

      // todo overwritten in parseNew
      // parseNewCallee(node: N.NewExpression): void {
      //   super.parseNewCallee(node);
      //
      //   const { callee } = node;
      //   if (
      //     callee.type === "TSInstantiationExpression" &&
      //     !callee.extra?.parenthesized
      //   ) {
      //     node.typeParameters = callee.typeParameters;
      //     node.callee = callee.expression;
      //   }
      // }

      // todo we don't support export default from now
      isExportDefaultSpecifier(): boolean {
        if (this.tsIsDeclarationStart()) return false

        const { type } = this
        if (tokenIsIdentifier(type)) {
          if ((type === tsTokenType.async && !this.containsEsc) || type === tsTokenType.let) {
            return false
          }
          if (
            (type === tsTokenType.type || type === tsTokenType.interface) &&
            !this.containsEsc
          ) {
            const { type: nextType } = this.lookahead()
            // If we see any variable name other than `from` after `type` keyword,
            // we consider it as flow/typescript type exports
            // note that this approach may fail on some pedantic cases
            // export type from = number
            if (
              (tokenIsIdentifier(nextType) && nextType !== tsTokenType.from) ||
              nextType === tokTypes.braceL
            ) {
              return false
            }
          }
        } else if (!this.match(tokTypes._default)) {
          return false
        }

        const next = this.nextTokenStart()
        const hasFrom = this.isUnparsedContextual(next, 'from')
        if (
          this.input.charCodeAt(next) === charCodes.comma ||
          (tokenIsIdentifier(this.type) && hasFrom)
        ) {
          return true
        }
        // lookahead again when `export default from` is seen
        if (this.match(tokTypes._default) && hasFrom) {
          const nextAfterFrom = this.input.charCodeAt(
            this.nextTokenStartSince(next + 4)
          )
          return (
            nextAfterFrom === charCodes.quotationMark ||
            nextAfterFrom === charCodes.apostrophe
          )
        }
        return false
      }

      parseTemplate({isTagged = false} = {}) {
        let node = this.startNode()
        this.next()
        node.expressions = []
        let curElt = this.parseTemplateElement({isTagged})
        node.quasis = [curElt]
        while (!curElt.tail) {
          if (this.type === tokTypes.eof) this.raise(this.pos, "Unterminated template literal")
          this.expect(tokTypes.dollarBraceL)
          // NOTE: extend parseTemplateSubstitution
          node.expressions.push(this.inType ? this.tsParseType() : this.parseExpression())
          this.expect(tokTypes.braceR)
          node.quasis.push(curElt = this.parseTemplateElement({isTagged}))
        }
        this.next()
        return this.finishNode(node, "TemplateLiteral")
      }

      parseFunctionBodyAndFinish(node: Node, type: string, isMethod: boolean = false) {
        if (this.match(tokTypes.colon)) {
          node.returnType = this.tsParseTypeOrTypePredicateAnnotation(tokTypes.colon)
        }

        const bodilessType =
          type === 'FunctionDeclaration'
            ? 'TSDeclareFunction'
            : type === 'ClassMethod' || type === 'ClassPrivateMethod'
              ? 'TSDeclareMethod'
              : undefined
        if (bodilessType && !this.match(tokTypes.braceL) && this.isLineTerminator()) {
          return this.finishNode(node, bodilessType)
        }
        if (bodilessType === 'TSDeclareFunction' && this.isAmbientContext) {
          this.raise(node.start, TSErrors.DeclareFunctionHasImplementation)
          if ((node as FunctionDeclaration).declare) {
            this.parseFunctionBody(node, false, isMethod, false)
            return this.finishNode(node, bodilessType)
          }
        }

        this.parseFunctionBody(node, false, isMethod, false)
        return this.finishNode(node, type)
      }

      parseNew() {
        if (this.containsEsc) this.raiseRecoverable(this.start, 'Escape sequence in keyword new')
        let node = this.startNode()
        let meta = this.parseIdent(true)
        if (this.options.ecmaVersion >= 6 && this.eat(tokTypes.dot)) {
          node.meta = meta
          let containsEsc = this.containsEsc
          node.property = this.parseIdent(true)
          if (node.property.name !== 'target')
            this.raiseRecoverable(node.property.start, 'The only valid meta property for new is \'new.target\'')
          if (containsEsc)
            this.raiseRecoverable(node.start, '\'new.target\' must not contain escaped characters')
          if (!this.allowNewDotTarget)
            this.raiseRecoverable(node.start, '\'new.target\' can only be used in functions and class static block')
          return this.finishNode(node, 'MetaProperty')
        }
        let startPos = this.start, startLoc = this.startLoc,
          isImport = this.type === tokTypes._import
        node.callee = this.parseSubscripts(this.parseExprAtom(), startPos, startLoc, true, false)
        if (isImport && node.callee.type === 'ImportExpression') {
          this.raise(startPos, 'Cannot use new with import()')
        }
        // ---start parseNewCallee extension
        const { callee } = node
        if (
          callee.type === 'TSInstantiationExpression' &&
          !callee.extra?.parenthesized
        ) {
          node.typeParameters = callee.typeParameters
          node.callee = callee.expression
        }
        // ---end
        if (this.eat(tokTypes.parenL)) node.arguments = this.parseExprList(tokTypes.parenR, this.options.ecmaVersion >= 8, false)
        else node.arguments = empty
        return this.finishNode(node, 'NewExpression')
      }

      parseExprOp(
        left: Expression,
        leftStartPos: number,
        leftStartLoc: Position,
        minPrec: number,
        forInit: boolean
      ): Expression {
        if (
          tokTypes._in.binop > minPrec &&
          !this.hasPrecedingLineBreak() &&
          this.ts_isContextual(tokTypes.as)
        ) {
          const node = this.startNodeAt(
            leftStartPos,
            leftStartLoc
          )
          node.expression = left
          const _const = this.tsTryNextParseConstantContext()
          if (_const) {
            node.typeAnnotation = _const
          } else {
            node.typeAnnotation = this.tsNextThenParseType()
          }
          this.finishNode(node, 'TSAsExpression')
          // rescan `<`, `>` because they were scanned when this.state.inType was true
          this.reScan_lt_gt()
          return this.parseExprOp(
            // @ts-expect-error todo(flow->ts)
            node,
            leftStartPos,
            leftStartLoc,
            minPrec,
            forInit
          )
        }

        return super.parseExprOp(left, leftStartPos, leftStartLoc, minPrec)
      }

      /**
       * @param {Node} node this may be ImportDeclaration |
       * TsImportEqualsDeclaration
       * @returns AnyImport
       * */
      parseImport(
        node: any
      ) {
        this.next()
        node.importKind = 'value'
        if (
          tokenIsIdentifier(this.type) ||
          this.match(tokTypes.star) ||
          this.match(tokTypes.braceL)
        ) {
          let ahead = this.lookahead()
          if (
            this.ts_type_isContextual(this.type, tsTokenType.type) &&
            // import type, { a } from "b";
            ahead.type !== tokTypes.comma &&
            // import type from "a";
            ahead.type !== tsTokenType.from &&
            // import type = require("a");
            ahead.type !== tokTypes.eq
          ) {
            node.importKind = 'type'
            this.next()
            ahead = this.lookahead()
          }

          if (tokenIsIdentifier(this.type) && ahead.type === tokTypes.eq) {
            return this.tsParseImportEqualsDeclaration(node)
          }
        }

        // ---start origin parseImport
        if (this.type === tokTypes.string) {
          node.specifiers = empty
          node.source = this.parseExprAtom()
        } else {
          node.specifiers = this.parseImportSpecifiers()
          this.expectContextual('from')
          node.source = this.type === tokTypes.string ? this.parseExprAtom() : this.unexpected()
        }
        super.semicolon()
        const importNode = this.finishNode(node, 'ImportDeclaration')
        // ---end

        /*:: invariant(importNode.type !== "TSImportEqualsDeclaration") */

        // `import type` can only be used on imports with named imports or with a
        // default import - but not both
        if (
          importNode.importKind === 'type' &&
          importNode.specifiers.length > 1 &&
          importNode.specifiers[0].type === 'ImportDefaultSpecifier'
        ) {
          this.raise(importNode.start, TypeScriptError.TypeImportCannotSpecifyDefaultAndNamed)
        }

        return importNode
      }

      parseExport(node: Node, exports: any): Node {
        this.next()
        if (this.match(tokTypes._import)) {
          this.next() // eat `tokTypes._import`
          if (
            this.ts_isContextual(tsTokenType.type) &&
            this.lookaheadCharCode() !== charCodes.equalsTo
          ) {
            node.importKind = 'type'
            this.next() // eat "type"
          } else {
            node.importKind = 'value'
          }
          return this.tsParseImportEqualsDeclaration(
            node,
            /* isExport */ true
          )
        } else if (this.eat(tokTypes.eq)) {
          // `export = x;`
          const assign = node
          assign.expression = this.parseExpression()
          this.semicolon()
          return this.finishNode(assign, 'TSExportAssignment')
        } else if (this.eatContextual('as')) {
          // `export as namespace A;`
          const decl = node
          // See `parseNamespaceExportDeclaration` in TypeScript's own parser
          this.expectContextual(tsTokenType.namespace)
          decl.id = this.parseIdent()
          this.semicolon()
          return this.finishNode(decl, 'TSNamespaceExportDeclaration')
        } else {
          if (
            this.ts_isContextual(tsTokenType.type) &&
            this.lookahead().type === tokTypes.braceL
          ) {
            this.next()
            node.exportKind = 'type'
          } else {
            node.exportKind = 'value'
          }

          // ---start origin parseExport
          // export * from '...'
          if (this.eat(tokTypes.star)) {
            if (this.options.ecmaVersion >= 11) {
              if (this.eatContextual('as')) {
                node.exported = this.parseModuleExportName()
                this.checkExport(exports, node.exported, this.lastTokStart)
              } else {
                node.exported = null
              }
            }
            this.expectContextual('from')
            if (this.type !== tokTypes.string) this.unexpected()
            node.source = this.parseExprAtom()
            this.semicolon()
            return this.finishNode(node, 'ExportAllDeclaration')
          }
          if (this.eat(tokTypes._default)) { // export default ...
            // ---start ts extension
            if (this.isAbstractClass()) {
              const cls = this.startNode<Class>()
              this.next() // Skip "abstract"
              cls.abstract = true
              return this.parseClass(cls, true, true)
            }

            // export default interface allowed in:
            // https://github.com/Microsoft/TypeScript/pull/16040
            if (this.match(tsTokenType.interface)) {
              const result = this.tsParseInterfaceDeclaration(this.startNode())
              if (result) return result
            }
            // ---end
            this.checkExport(exports, 'default', this.lastTokStart)
            let isAsync
            if (this.type === tokTypes._function || (isAsync = this.isAsyncFunction())) {
              let fNode = this.startNode()
              this.next()
              if (isAsync) this.next()
              node.declaration = this.parseFunction(fNode, FUNC_STATEMENT | FUNC_NULLABLE_ID, false, isAsync)
            } else if (this.type === tokTypes._class) {
              let cNode = this.startNode()
              node.declaration = this.parseClass(cNode, 'nullableID')
            } else {
              node.declaration = this.parseMaybeAssign()
              this.semicolon()
            }
            return this.finishNode(node, 'ExportDefaultDeclaration')
          }
          // export var|const|let|function|class ...
          if (this.shouldParseExportStatement()) {
            node.declaration = this.parseExportDeclaration(node)
            if (node.declaration.type === 'VariableDeclaration')
              this.checkVariableExport(exports, node.declaration.declarations)
            else
              this.checkExport(exports, node.declaration.id, node.declaration.id.start)
            node.specifiers = []
            node.source = null
          } else { // export { x, y as z } [from '...']
            node.declaration = null
            const isTypeExport = node.exportKind === 'type'
            node.specifiers = this.parseExportSpecifiers(exports, isTypeExport)
            if (this.eatContextual('from')) {
              if (this.type !== tokTypes.string) this.unexpected()
              node.source = this.parseExprAtom()
            } else {
              for (let spec of node.specifiers) {
                // check for keywords used as local names
                this.checkUnreserved(spec.local)
                // check if export is defined
                this.checkLocalExport(spec.local)

                if (spec.local.type === 'Literal') {
                  this.raise(spec.local.start, 'A string literal cannot be used as an exported binding without `from`.')
                }
              }

              node.source = null
            }
            this.semicolon()
          }
          return this.finishNode(node, 'ExportNamedDeclaration')
          // ---end
        }
      }

      // todo we don't need these functions, we have to rewrite the
      //  parseClassElement function in acorn
      // === === === === === === === === === === === === === === === ===
      // Note: All below methods are duplicates of something in flow.js.
      // Not sure what the best way to combine these is.
      // === === === === === === === === === === === === === === === ===

      // isClassMethod(): boolean {
      //   return this.match(tt.lt) || super.isClassMethod();
      // }
      //
      // isClassProperty(): boolean {
      //   return (
      //     this.match(tt.bang) || this.match(tt.colon) || super.isClassProperty()
      //   );
      // }

      parseMaybeDefault(
        startPos?: number | null,
        startLoc?: Position | null,
        left?: Pattern | null
      ): Pattern {
        const node = super.parseMaybeDefault(startPos, startLoc, left)

        if (
          node.type === 'AssignmentPattern' &&
          node.typeAnnotation &&
          node.right.start < node.typeAnnotation.start
        ) {
          this.raise(node.typeAnnotation.loc.start, TSErrors.TypeAnnotationAfterAssign)
        }

        return node
      }

      typeCastToParameter(node: Node): Node {
        node.expression.typeAnnotation = node.typeAnnotation

        this.resetEndLocation(node.expression, node.typeAnnotation.loc.end)

        return node.expression
      }

      toAssignableList(
        exprList: Expression[],
        isBinding: boolean
      ): void {
        for (let i = 0; i < exprList.length; i++) {
          const expr = exprList[i]
          if (expr?.type === 'TSTypeCastExpression') {
            exprList[i] = this.typeCastToParameter(expr)
          }
        }
        super.toAssignableList(exprList, isBinding)
      }

      reportReservedArrowTypeParam(node: any) {
        if (
          node.params.length === 1 &&
          !node.extra?.trailingComma &&
          disallowAmbiguousJSXLike
        ) {
          this.raise(node.start, TSErrors.ReservedArrowTypeParam)
        }
      }

      // Handle type assertions
      parseMaybeUnary(
        refExpressionErrors?: any,
        sawUnary?: boolean
      ): Expression {
        // todo support jsx
        // if (!this.hasPlugin("jsx") && this.match(tt.lt)) {
        //   return this.tsParseTypeAssertion();
        // } else {
        // }

        return super.parseMaybeUnary(refExpressionErrors, sawUnary)
      }

      parseExprAtom(refDestructuringErrors, forInit) {
        // If a division operator appears in an expression position, the
        // tokenizer got confused, and we force it to read a regexp instead.
        if (this.type === tokTypes.slash) this.readRegexp()

        let node, canBeArrow = this.potentialArrowAt === this.start
        switch (this.type) {
          case tokTypes._super:
            if (!this.allowSuper)
              this.raise(this.start, '\'super\' keyword outside a method')
            node = this.startNode()
            this.next()
            if (this.type === tokTypes.parenL && !this.allowDirectSuper)
              this.raise(node.start, 'super() call outside constructor of a subclass')
            // The `super` keyword can appear at below:
            // SuperProperty:
            //     super [ Expression ]
            //     super . IdentifierName
            // SuperCall:
            //     super ( Arguments )
            if (this.type !== tokTypes.dot && this.type !== tokTypes.bracketL && this.type !== tokTypes.parenL)
              this.unexpected()
            return this.finishNode(node, 'Super')

          case tokTypes._this:
            node = this.startNode()
            this.next()
            return this.finishNode(node, 'ThisExpression')

          case tokTypes.name:
            let startPos = this.start, startLoc = this.startLoc,
              containsEsc = this.containsEsc
            let id = this.parseIdent(false)
            if (this.options.ecmaVersion >= 8 && !containsEsc && id.name === 'async' && !this.canInsertSemicolon() && this.eat(tokTypes._function)) {
              this.overrideContext(tokenCtxTypes.f_expr)
              return this.parseFunction(this.startNodeAt(startPos, startLoc), 0, false, true, forInit)
            }
            if (canBeArrow && !this.canInsertSemicolon()) {
              if (this.eat(tokTypes.arrow))
                return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), [id], false, forInit)
              if (this.options.ecmaVersion >= 8 && id.name === 'async' && this.type === tokTypes.name && !containsEsc &&
                (!this.potentialArrowInForAwait || this.value !== 'of' || this.containsEsc)) {
                id = this.parseIdent(false)
                if (this.canInsertSemicolon() || !this.eat(tokTypes.arrow))
                  this.unexpected()
                return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), [id], true, forInit)
              }
            }
            return id

          case tokTypes.regexp:
            let value = this.value
            node = this.parseLiteral(value.value)
            node.regex = { pattern: value.pattern, flags: value.flags }
            return node

          case tokTypes.num:
          case tokTypes.string:
            return this.parseLiteral(this.value)

          case tokTypes._null:
          case tokTypes._true:
          case tokTypes._false:
            node = this.startNode()
            node.value = this.type === tokTypes._null ? null : this.type === tokTypes._true
            node.raw = this.type.keyword
            this.next()
            return this.finishNode(node, 'Literal')

          case tokTypes.parenL:
            let start = this.start,
              expr = this.parseParenAndDistinguishExpression(canBeArrow, forInit)
            if (refDestructuringErrors) {
              if (refDestructuringErrors.parenthesizedAssign < 0 && !this.isSimpleAssignTarget(expr))
                refDestructuringErrors.parenthesizedAssign = start
              if (refDestructuringErrors.parenthesizedBind < 0)
                refDestructuringErrors.parenthesizedBind = start
            }
            return expr

          case tokTypes.bracketL:
            node = this.startNode()
            this.next()
            node.elements = this.parseExprList(tokTypes.bracketR, true, true, refDestructuringErrors)
            // NODE check array like here
            this.tsCheckForInvalidTypeCasts(node.elements)
            return this.finishNode(node, 'ArrayExpression')

          case tokTypes.braceL:
            this.overrideContext(tokenCtxTypes.b_expr)
            return this.parseObj(false, refDestructuringErrors)

          case tokTypes._function:
            node = this.startNode()
            this.next()
            return this.parseFunction(node, 0)

          case tokTypes._class:
            return this.parseClass(this.startNode(), false)

          case tokTypes._new:
            return this.parseNew()

          case tokTypes.backQuote:
            return this.parseTemplate()

          case tokTypes._import:
            if (this.options.ecmaVersion >= 11) {
              return this.parseExprImport()
            } else {
              return this.unexpected()
            }

          default:
            this.unexpected()
        }
      }

      parseVar(node, isFor, kind, allowMissingInitializer: boolean = false) {
        node.declarations = []
        node.kind = kind
        for (; ;) {
          let decl = this.startNode()
          this.parseVarId(decl, kind)
          if (this.eat(tokTypes.eq)) {
            decl.init = this.parseMaybeAssign(isFor)
          } else if (!allowMissingInitializer && kind === 'const' && !(this.type === tokTypes._in || (this.options.ecmaVersion >= 6 && this.isContextual('of')))) {
            this.unexpected()
          } else if (!allowMissingInitializer && decl.id.type !== 'Identifier' && !(isFor && (this.type === tokTypes._in || this.isContextual('of')))) {
            this.raise(this.lastTokEnd, 'Complex binding patterns require an initialization value')
          } else {
            decl.init = null
          }
          node.declarations.push(this.finishNode(decl, 'VariableDeclarator'))
          if (!this.eat(tokTypes.comma)) break
        }
        return node
      }

      parseVarStatement(node, kind, allowMissingInitializer: boolean = false) {
        const { isAmbientContext } = this

        // ---start origin parseVarStatement
        this.next()
        this.parseVar(node, false, kind, allowMissingInitializer || isAmbientContext)
        this.semicolon()
        const declaration = this.finishNode(node, 'VariableDeclaration')
        // ---end

        if (!isAmbientContext) return declaration

        for (const { id, init } of declaration.declarations) {
          // Empty initializer is the easy case that we want.
          if (!init) continue

          // var and let aren't ever allowed initializers.
          //
          // If a const declaration has no type annotation and is initiailized to
          // a string literal, numeric literal, or enum reference, then it is
          // allowed. In an ideal world, we'd check whether init was *actually* an
          // enum reference, but we allow anything that "could be" a literal enum
          // in `isPossiblyLiteralEnum` since we don't have all the information
          // that the typescript compiler has.
          if (kind !== 'const' || !!id.typeAnnotation) {
            this.raise(init.start, TSErrors.InitializerNotAllowedInAmbientContext)
          } else if (
            init.type !== 'StringLiteral' &&
            init.type !== 'BooleanLiteral' &&
            init.type !== 'NumericLiteral' &&
            init.type !== 'BigIntLiteral' &&
            (init.type !== 'TemplateLiteral' || init.expressions.length > 0) &&
            !isPossiblyLiteralEnum(init)
          ) {
          }
          this.raise(
            init.start,
            TSErrors.ConstInitiailizerMustBeStringOrNumericLiteralOrLiteralEnumReference
          )
        }

        return declaration
      }

      parseStatement(context: any, topLevel: any, exports: any) {
        if (this.match(tokTypes._const) && this.isLookaheadContextual('enum')) {
          const node = this.startNode()
          this.expect(tokTypes._const) // eat 'const'
          return this.tsParseEnumDeclaration(node, { const: true })
        }

        if (this.ts_isContextual(tsTokenType.enum)) {
          return this.tsParseEnumDeclaration(
            this.startNode()
          )
        }

        if (this.ts_isContextual(tsTokenType.interface)) {
          const result = this.tsParseInterfaceDeclaration(this.startNode())
          if (result) return result
        }

        return super.parseStatement(context, topLevel, exports)
      }

      // NOTE: unused function
      parseAccessModifier(): Accessibility | undefined | null {
        return this.tsParseModifier(['public', 'protected', 'private'])
      }

      parsePostMemberNameModifiers(
        methodOrProp: Node
      ): void {
        const optional = this.eat(tokTypes.question)
        if (optional) methodOrProp.optional = true

        if ((methodOrProp as any).readonly && this.match(tokTypes.parenL)) {
          this.raise(methodOrProp.start, TSErrors.ClassMethodHasReadonly)
        }

        if ((methodOrProp as any).declare && this.match(tokTypes.parenL)) {
          this.raise(methodOrProp.start, TSErrors.ClassMethodHasDeclare)
        }
      }

      // Note: The reason we do this in `parseExpressionStatement` and not `parseStatement`
      // is that e.g. `type()` is valid JS, so we must try parsing that first.
      // If it's really a type, we will parse `type` as the statement, and can correct it here
      // by parsing the rest.
      // @ts-expect-error plugin overrides interfaces
      parseExpressionStatement(
        node,
        expr
      ) {
        const decl =
          expr.type === 'Identifier'
            ? // @ts-expect-error refine typings
            this.tsParseExpressionStatement(node, expr)
            : undefined
        return decl || super.parseExpressionStatement(node, expr)
      }

      // todo this is shouldParseExportDeclaration
      shouldParseExportStatement(): boolean {
        if (this.tsIsDeclarationStart()) return true
        return super.shouldParseExportStatement()
      }

      parseConditional(
        expr: Expression,
        startPos: number,
        startLoc: Position,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        refDestructuringErrors?: any) {
        if (this.eat(tokTypes.question)) {
          let node = this.startNodeAt(startPos, startLoc)
          node.test = expr
          node.consequent = this.parseMaybeAssign()
          this.expect(tokTypes.colon)
          node.alternate = this.parseMaybeAssign(forInit)
          return this.finishNode(node, 'ConditionalExpression')
        }
        return expr
      }

      parseMaybeConditional(forInit, refDestructuringErrors) {
        let startPos = this.start, startLoc = this.startLoc
        let expr = this.parseExprOps(forInit, refDestructuringErrors)
        if (this.checkExpressionErrors(refDestructuringErrors)) return expr
        // todo parseConditional ts support
        if (!this.maybeInArrowParameters || !this.match(tokTypes.question)) {
          return this.parseConditional(
            expr,
            startPos,
            startLoc
          )
        }

        const result = this.tryParse(() =>
          this.parseConditional(expr, startPos, startLoc)
        )

        if (!result.node) {
          if (result.error) {
            /*:: invariant(refExpressionErrors != null) */
            this.setOptionalParametersError(refDestructuringErrors, result.error)
          }

          return expr
        }
        if (result.error) this.setLookaheadState(result.failState)
        return result.node
      }

      parseParenItem(node: Expression) {
        const startPos = this.start
        const startLoc = this.startLoc

        node = super.parseParenItem(node)
        if (this.eat(tokTypes.question)) {
          node.optional = true
          // Include questionmark in location of node
          // Don't use this.finishNode() as otherwise we might process comments twice and
          // include already consumed parens
          this.resetEndLocation(node)
        }

        if (this.match(tokTypes.colon)) {
          const typeCastNode = this.startNodeAt(
            startPos,
            startLoc
          )
          typeCastNode.expression = node
          typeCastNode.typeAnnotation = this.tsParseTypeAnnotation()

          return this.finishNode(typeCastNode, 'TSTypeCastExpression')
        }

        return node
      }

      parseExportDeclaration(
        node: N.ExportNamedDeclaration
      ): N.Declaration | undefined | null {
        if (!this.isAmbientContext && this.ts_isContextual(tsTokenType.declare)) {
          return this.tsInAmbientContext(() => this.parseExportDeclaration(node))
        }

        // Store original location/position
        const startPos = this.start
        const startLoc = this.startLoc

        const isDeclare = this.eatContextual('declare')

        if (
          isDeclare &&
          (this.ts_isContextual(tsTokenType.declare) || !this.shouldParseExportStatement())
        ) {
          this.raise(this.start, TSErrors.ExpectedAmbientAfterExportDeclare)
        }

        const isIdentifier = tokenIsIdentifier(this.type)
        const declaration =
          (isIdentifier && this.tsTryParseExportDeclaration()) ||
          this.parseStatement(null)

        if (!declaration) return null

        if (
          declaration.type === 'TSInterfaceDeclaration' ||
          declaration.type === 'TSTypeAliasDeclaration' ||
          isDeclare
        ) {
          node.exportKind = 'type'
        }

        if (isDeclare) {
          // Reset location to include `declare` in range
          this.resetStartLocation(declaration, startPos, startLoc)

          declaration.declare = true
        }

        return declaration
      }

      parseClassId(
        node: Class,
        isStatement: boolean
      ): void {
        if ((!isStatement) && this.ts_isContextual(tsTokenType.implements)) {
          return
        }

        super.parseClassId(
          node,
          isStatement
        )
        const typeParameters = this.tsTryParseTypeParameters(
          this.tsParseInOutModifiers.bind(this)
        )
        if (typeParameters) node.typeParameters = typeParameters
      }

      parseClassPropertyAnnotation(
        node: Node
      ): void {
        if (!node.optional && this.eat(tsTokenType.bang)) {
          node.definite = true
        }

        const type = this.tsTryParseTypeAnnotation()
        if (type) node.typeAnnotation = type
      }

      parsePrivateClassField(field) {
        // --- start ts parseClassPrivateProperty
        if (field.abstract) {
          this.raise(field.start, TSErrors.PrivateElementHasAbstract)
        }

        // @ts-expect-error accessibility may not index node
        if (field.accessibility) {
          this.raise(field.start, TSErrors.PrivateElementHasAccessibility({
            // @ts-expect-error refine typings
            modifier: field.accessibility
          }))
        }

        this.parseClassPropertyAnnotation(field)
        // --- end

        return super.parseClassField(field)
      }

      parseClassField(field) {
        // --- start ts parseClassProperty
        this.parseClassPropertyAnnotation(field)

        if (
          this.isAmbientContext &&
          !(field.readonly && !field.typeAnnotation) &&
          this.match(tokTypes.eq)
        ) {
          this.raise(this.startLoc, TSErrors.DeclareClassFieldHasInitializer)
        }
        if (field.abstract && this.match(tokTypes.eq)) {
          const { key } = field
          this.raise(this.startLoc, TSErrors.AbstractPropertyHasInitializer({
            propertyName:
              key.type === 'Identifier' && !field.computed
                ? key.name
                : `[${this.input.slice(key.start, key.end)}]`
          }))
        }
        // --- end

        return super.parseClassField(field)
      }

      parsePrivateClassMethod(method, isGenerator, isAsync, allowsDirectSuper) {
        const typeParameters = this.tsTryParseTypeParameters()
        if (typeParameters) method.typeParameters = typeParameters
        super.parseClassMethod(method, isGenerator, isAsync, allowsDirectSuper)
      }

      parseClassMethod(method, isGenerator, isAsync, allowsDirectSuper) {
        // start typescript parse class method
        const isConstructor = method.kind === 'constructor'
        // todo pushClassPrivateMethod
        const typeParameters = this.tsTryParseTypeParameters()
        if (typeParameters && isConstructor) {
          this.raise(TSErrors.ConstructorHasTypeParameters, {
            at: typeParameters
          })
        }

        // @ts-expect-error declare does not exist in ClassMethod
        const { declare = false, kind } = method

        if (declare && (kind === 'get' || kind === 'set')) {
          this.raise(TSErrors.DeclareAccessor, { at: method, kind })
        }
        if (typeParameters) method.typeParameters = typeParameters
        // end

        super.parseClassMethod(method, isGenerator, isAsync, allowsDirectSuper)
      }

      parseClassElementName(element) {
        if (this.type === tokTypes.privateId) {
          if (this.value === 'constructor') {
            this.raise(this.start, 'Classes can\'t have an element named \'#constructor\'')
          }
          element.computed = false
          element.key = this.parsePrivateIdent()
        } else {
          this.parsePropertyName(element)
        }
      }

      parseClassElement(constructorAllowsSuper) {
        if (this.eat(tokTypes.semi)) return null

        const ecmaVersion = this.options.ecmaVersion
        const node = this.startNode()
        let keyName = ''
        let isGenerator = false
        let isAsync = false
        let kind = 'method'
        let isStatic = false

        // todo parseClassMember
        // --- start parseClassMember extension
        const modifiers = [
          'declare',
          'private',
          'public',
          'protected',
          'override',
          'abstract',
          'readonly',
          'static'
        ] as const
        this.tsParseModifiers({
          modified: node,
          allowedModifiers: modifiers,
          disallowedModifiers: ['in', 'out'],
          stopOnStartOfClassStaticBlock: true,
          errorTemplate: TSErrors.InvalidModifierOnTypeParameterPositions
        })

        const callParseClassMemberWithIsStatic = () => {
          if (this.tsIsStartOfStaticBlocks()) {
            this.next() // eat "static"
            this.next() // eat "{"
            if (this.tsHasSomeModifiers(node, modifiers)) {
              this.raise(this.curPosition().start, TSErrors.StaticBlockCannotHaveModifier)
            }

            if (ecmaVersion >= 13) {
              super.parseClassStaticBlock(
                node
              )
              return node
            }
          } else {
            // todo parseClassMemberWithIsStatic
            // --- start ts extension
            const idx = this.tsTryParseIndexSignature(node)
            if (idx) {
              if ((node as any).abstract) {
                this.raise(node.start, TSErrors.IndexSignatureHasAbstract)
              }
              if ((node as any).accessibility) {
                this.raise(node.start, TSErrors.IndexSignatureHasAccessibility({
                  modifier: (node as any).accessibility
                }))
              }
              if ((node as any).declare) {
                this.raise(node.start, TSErrors.IndexSignatureHasDeclare)
              }
              if ((node as any).override) {
                this.raise(node.start, TSErrors.IndexSignatureHasOverride)
              }

              return idx
            }

            if (!this.inAbstractClass && (node as any).abstract) {
              this.raise(node.start, TSErrors.NonAbstractClassHasAbstractMethod)
            }

            if ((node as any).override) {
              if (constructorAllowsSuper) {
                this.raise(node.start, TSErrors.OverrideNotInSubClass)
              }
            }
            // --- end


            node.static = isStatic
            // todo we don't need parsePropertyNamePrefixOperator here, this
            //  plugin don't support flow
            //  this.parsePropertyNamePrefixOperator(member);
            if (!keyName && ecmaVersion >= 8 && this.eatContextual('async')) {
              if ((this.isClassElementNameStart() || this.type === tokTypes.star) && !this.canInsertSemicolon()) {
                isAsync = true
              } else {
                keyName = 'async'
              }
            }
            if (!keyName && (ecmaVersion >= 9 || !isAsync) && this.eat(tokTypes.star)) {
              isGenerator = true
            }
            if (!keyName && !isAsync && !isGenerator) {
              const lastValue = this.value
              if (this.eatContextual('get') || this.eatContextual('set')) {
                if (this.isClassElementNameStart()) {
                  kind = lastValue
                } else {
                  keyName = lastValue
                }
              }
            }

            let isPrivate = this.type === tokTypes.privateId
            // Parse element name
            if (keyName) {
              // 'async', 'get', 'set', or 'static' were not a keyword contextually.
              // The last token is any of those. Make it the element name.
              node.computed = false
              node.key = this.startNodeAt(this.lastTokStart, this.lastTokStartLoc)
              node.key.name = keyName
              this.finishNode(node.key, 'Identifier')
            } else {
              this.parseClassElementName(node)
            }

            // todo isClassMethod
            const isClassMethod = this.match(tokTypes.relational) || this.match(tokTypes.parenL)
            // Parse element value
            if (ecmaVersion < 13 || isClassMethod || kind !== 'method' || isGenerator || isAsync) {
              const isConstructor = !node.static && checkKeyName(node, 'constructor')
              const allowsDirectSuper = isConstructor && constructorAllowsSuper
              // Couldn't move this check into the 'parseClassMethod' method for backward compatibility.
              if (isConstructor && kind !== 'method') this.raise(node.key.start, 'Constructor can\'t have get/set modifier')
              node.kind = isConstructor ? 'constructor' : kind
              // ts Overridden
              this.parsePostMemberNameModifiers(node)
              // todo private or not
              if (!isPrivate) {
                this.parseClassMethod(node, isGenerator, isAsync, allowsDirectSuper)
              } else {
                this.parsePrivateClassMethod(node, isGenerator, isAsync, allowsDirectSuper)
              }
            } else {
              // ts Overridden
              this.parsePostMemberNameModifiers(node)
              // todo private or not
              if (!isPrivate) {
                this.parseClassField(node)
              } else {
                this.parsePrivateClassField(node)
              }
            }

            return node
          }
        }
        if (node.declare) {
          this.tsInAmbientContext(callParseClassMemberWithIsStatic)
        } else {
          callParseClassMemberWithIsStatic()
        }
        // --- end
        return node
      }

      // todo parseClassMethod
      // pushClassPrivateMethod(
      //   classBody: N.ClassBody,
      //   method: N.ClassPrivateMethod,
      //   isGenerator: boolean,
      //   isAsync: boolean,
      // ): void {
      //   const typeParameters = this.tsTryParseTypeParameters();
      //   if (typeParameters) method.typeParameters = typeParameters;
      //   super.pushClassPrivateMethod(classBody, method, isGenerator, isAsync);
      // }

      // todo parseClassMethod
      // declareClassPrivateMethodInScope(
      //   node: N.ClassPrivateMethod | N.EstreeMethodDefinition | N.TSDeclareMethod,
      //   kind: number,
      // ) {
      //   if (node.type === "TSDeclareMethod") return;
      //   // This happens when using the "estree" plugin.
      //   if (node.type === "MethodDefinition" && !node.value.body) return;
      //
      //   super.declareClassPrivateMethodInScope(node, kind);
      // }

      parseClassSuper(node: Class): void {
        super.parseClassSuper(node)
        // handle `extends f<<T>
        if (node.superClass && (this.match(tokTypes.relational) || this.match(tokTypes.bitShift))) {
          // @ts-expect-error refine typings
          node.superTypeParameters = this.tsParseTypeArgumentsInExpression()
        }
        if (this.eatContextual('implements')) {
          node.implements = this.tsParseHeritageClause('implements')
        }
      }

      // todo parsePropertyValue
      // parseObjPropValue(
      //   prop: Undone<N.ObjectMethod | N.ObjectProperty>,
      //   startPos: number | undefined | null,
      //   startLoc: Position | undefined | null,
      //   isGenerator: boolean,
      //   isAsync: boolean,
      //   isPattern: boolean,
      //   isAccessor: boolean,
      //   refExpressionErrors?: ExpressionErrors | null
      // ) {
      //   const typeParameters = this.tsTryParseTypeParameters()
      //   if (typeParameters) prop.typeParameters = typeParameters
      //
      //   return super.parseObjPropValue(
      //     prop,
      //     startPos,
      //     startLoc,
      //     isGenerator,
      //     isAsync,
      //     isPattern,
      //     isAccessor,
      //     refExpressionErrors
      //   )
      // }

      parseFunctionParams(node: Function): void {
        const typeParameters = this.tsTryParseTypeParameters()
        if (typeParameters) node.typeParameters = typeParameters
        super.parseFunctionParams(node)
      }

      // `let x: number;`
      parseVarId(
        decl: VariableDeclarator,
        kind: 'var' | 'let' | 'const'
      ): void {
        super.parseVarId(decl, kind)

        if (
          decl.id.type === 'Identifier' &&
          !this.hasPrecedingLineBreak() &&
          // todo bang : type === prefix && value === '!'
          (this.eat(tokTypes.prefix) && this.value === '!')
        ) {
          decl.definite = true
        }

        const type = this.tsTryParseTypeAnnotation()
        if (type) {
          decl.id.typeAnnotation = type
          this.resetEndLocation(decl.id) // set end position to end of type
        }
      }

      // parse the return type of an async arrow function - let foo = (async (): number => {});
      parseArrowExpression(
        node: Node,
        params: Node[],
        isAsync: boolean,
        forInit: boolean
      ): ArrowFunctionExpression {
        if (this.match(tokTypes.colon)) {
          node.returnType = this.tsParseTypeAnnotation()
        }
        return super.parseArrowExpression(
          node,
          params,
          isAsync,
          forInit
        )
      }

      parseMaybeAssign(
        forInit: boolean,
        refExpressionErrors?: ExpressionErrors | null,
        afterLeftParse?: Function
      ): Expression {
        // Note: When the JSX plugin is on, type assertions (`<T> x`) aren't valid syntax.

        let state: LookaheadState | undefined | null
        let jsx
        let typeCast

        if (
          // todo we don't support jsx now
          // this.hasPlugin("jsx") &&
          false &&
          (this.match(tsTokenType.jsxTagStart) || this.match(tokTypes.relational))
        ) {
          // Prefer to parse JSX if possible. But may be an arrow fn.
          state = this.cloneCurLookaheadState()

          jsx = this.tryParse(
            () => super.parseMaybeAssign(forInit, refExpressionErrors, afterLeftParse),
            state
          )

          /*:: invariant(!jsx.aborted) */
          /*:: invariant(jsx.node != null) */
          if (!jsx.error) return jsx.node

          // Remove `tc.j_expr` or `tc.j_oTag` from context added
          // by parsing `jsxTagStart` to stop the JSX plugin from
          // messing with the tokens
          const { context } = this
          const currentContext = context[context.length - 1]

          // todo delete the follow lines
          // if (currentContext === tc.j_oTag || currentContext === tc.j_expr) {
          //   context.pop()
          // }
        }

        if (!jsx?.error && !this.match(tokTypes.relational)) {
          return super.parseMaybeAssign(forInit, refExpressionErrors, afterLeftParse)
        }

        // Either way, we're looking at a '<': tt.jsxTagStart or relational.

        // If the state was cloned in the JSX parsing branch above but there
        // have been any error in the tryParse call, this.state is set to state
        // so we still need to clone it.
        if (!state || this.compareLookaheadState(state, this.getCurLookaheadState())) {
          state = this.cloneCurLookaheadState()
        }

        let typeParameters: Node | undefined | null
        const arrow = this.tryParse(abort => {
          // This is similar to TypeScript's `tryParseParenthesizedArrowFunctionExpression`.
          typeParameters = this.tsParseTypeParameters()
          const expr = super.parseMaybeAssign(
            forInit,
            refExpressionErrors,
            afterLeftParse
          )

          if (
            expr.type !== 'ArrowFunctionExpression' ||
            expr.extra?.parenthesized
          ) {
            abort()
          }

          // Correct TypeScript code should have at least 1 type parameter, but don't crash on bad code.
          if (typeParameters?.params.length !== 0) {
            this.resetStartLocationFromNode(expr, typeParameters)
          }
          expr.typeParameters = typeParameters

          // todo we don't support BABEL_8_BREAKING
          // if (process.env.BABEL_8_BREAKING) {
          //   if (
          //     this.hasPlugin('jsx') &&
          //     expr.typeParameters.params.length === 1 &&
          //     !expr.typeParameters.extra?.trailingComma
          //   ) {
          //     // report error if single type parameter used without trailing comma.
          //     const parameter = expr.typeParameters.params[0]
          //     if (!parameter.constraint) {
          //       // A single type parameter must either have constraints
          //       // or a trailing comma, otherwise it's ambiguous with JSX.
          //       this.raise(TSErrors.SingleTypeParameterWithoutTrailingComma, {
          //         at: createPositionWithColumnOffset(parameter.loc.end, 1),
          //         typeParameterName: parameter.name.name
          //       })
          //     }
          //   }
          // }

          return expr
        }, state)

        /*:: invariant(arrow.node != null) */
        if (!arrow.error && !arrow.aborted) {
          // This error is reported outside of the this.tryParse call so that
          // in case of <T>(x) => 2, we don't consider <T>(x) as a type assertion
          // because of this error.
          if (typeParameters) this.reportReservedArrowTypeParam(typeParameters)
          // @ts-expect-error refine typings
          return arrow.node
        }

        if (!jsx) {
          // Try parsing a type cast instead of an arrow function.
          // This will never happen outside of JSX.
          // (Because in JSX the '<' should be a jsxTagStart and not a relational.

          // this will always be true
          // assert(!this.hasPlugin('jsx'))
          assert(true)

          // This will start with a type assertion (via parseMaybeUnary).
          // But don't directly call `this.tsParseTypeAssertion` because we want to handle any binary after it.
          typeCast = this.tryParse(
            () => super.parseMaybeAssign(forInit, refExpressionErrors, afterLeftParse),
            state
          )
          /*:: invariant(!typeCast.aborted) */
          /*:: invariant(typeCast.node != null) */
          if (!typeCast.error) return typeCast.node
        }

        if (jsx?.node) {
          /*:: invariant(jsx.failState) */
          this.setLookaheadState(jsx.failState)
          return jsx.node
        }

        if (arrow.node) {
          /*:: invariant(arrow.failState) */
          this.setLookaheadState(arrow.failState)
          if (typeParameters) this.reportReservedArrowTypeParam(typeParameters)
          // @ts-expect-error refine typings
          return arrow.node
        }

        if (typeCast?.node) {
          /*:: invariant(typeCast.failState) */
          this.setLookaheadState(typeCast.failState)
          return typeCast.node
        }

        if (jsx?.thrown) throw jsx.error
        if (arrow.thrown) throw arrow.error
        if (typeCast?.thrown) throw typeCast.error

        throw jsx?.error || arrow.error || typeCast?.error
      }

      parseArrow(
        node: ArrowFunctionExpression
      ): ArrowFunctionExpression | undefined | null {
        if (this.match(tokTypes.colon)) {
          // This is different from how the TS parser does it.
          // TS uses lookahead. The Babel Parser parses it as a parenthesized expression and converts.

          const result = this.tryParse(abort => {
            const returnType = this.tsParseTypeOrTypePredicateAnnotation(
              tokTypes.colon
            )
            if (this.canInsertSemicolon() || !this.match(tokTypes.arrow)) abort()
            return returnType
          })

          if (result.aborted) return

          if (!result.thrown) {
            if (result.error) this.state = result.failState
            // @ts-expect-error refine typings
            node.returnType = result.node
          }
        }

        if (this.eat(tokTypes.arrow)) {
          return node
        }
      }

      // Allow type annotations inside of a parameter list.
      parseAssignableListItemTypes(param: Pattern) {
        if (this.eat(tokTypes.question)) {
          if (
            param.type !== 'Identifier' &&
            !this.isAmbientContext &&
            !this.inType
          ) {
            this.raise(param.start, TSErrors.PatternIsOptional)
          }

          (param as any as Identifier).optional = true
        }
        const type = this.tsTryParseTypeAnnotation()
        if (type) param.typeAnnotation = type
        this.resetEndLocation(param)

        return param
      }

      isAssignable(node: Node, isBinding?: boolean): boolean {
        switch (node.type) {
          case 'TSTypeCastExpression':
            return this.isAssignable(node.expression, isBinding)
          case 'TSParameterProperty':
            return true
          case 'Identifier':
          case 'ObjectPattern':
          case 'ArrayPattern':
          case 'AssignmentPattern':
          case 'RestElement':
            return true

          case 'ObjectExpression': {
            const last = node.properties.length - 1
            return (node.properties as ObjectExpression['properties']).every(
              (prop, i) => {
                return (
                  prop.type !== 'ObjectMethod' &&
                  (i === last || prop.type !== 'SpreadElement') &&
                  this.isAssignable(prop)
                )
              }
            )
          }

          case 'ObjectProperty':
            return this.isAssignable(node.value)

          case 'SpreadElement':
            return this.isAssignable(node.argument)

          case 'ArrayExpression':
            return (node as ArrayExpression).elements.every(
              element => element === null || this.isAssignable(element)
            )

          case 'AssignmentExpression':
            return node.operator === '='

          case 'ParenthesizedExpression':
            return this.isAssignable(node.expression)

          case 'MemberExpression':
          case 'OptionalMemberExpression':
            return !isBinding

          default:
            return false
        }
      }

      toAssignable(
        node: Node,
        isBinding: boolean = false,
        refDestructuringErrors = new DestructuringErrors()
      ): void {
        switch (node.type) {
          case 'ParenthesizedExpression':
            this.toAssignableParenthesizedExpression(node, isBinding, refDestructuringErrors)
            break
          case 'TSAsExpression':
          case 'TSNonNullExpression':
          case 'TSTypeAssertion':
            if (isBinding) {
              // todo do nothing here
              // this.expressionScope.recordArrowParemeterBindingError(
              //   TSErrors.UnexpectedTypeCastInParameter,
              //   { at: node }
              // )
            } else {
              this.raise(node.start, TSErrors.UnexpectedTypeCastInParameter)
            }
            this.toAssignable(node.expression, isBinding, refDestructuringErrors)
            break
          case 'AssignmentExpression':
            if (!isBinding && node.left.type === 'TSTypeCastExpression') {
              node.left = this.typeCastToParameter(node.left)
            }
          /* fall through */
          default:
            super.toAssignable(node, isBinding, refDestructuringErrors)
        }
      }

      toAssignableParenthesizedExpression(
        node: Node,
        isBinding: boolean,
        refDestructuringErrors: DestructuringErrors
      ): void {
        switch (node.expression.type) {
          case 'TSAsExpression':
          case 'TSNonNullExpression':
          case 'TSTypeAssertion':
          case 'ParenthesizedExpression':
            this.toAssignable(node.expression, isBinding, refDestructuringErrors)
            break
          default:
            super.toAssignable(node, isBinding, refDestructuringErrors)
        }
      }

      // todo we don't need to check checkToRestConversion
      // checkToRestConversion(node: Node, allowPattern: boolean): void {
      //   switch (node.type) {
      //     case 'TSAsExpression':
      //     case 'TSTypeAssertion':
      //     case 'TSNonNullExpression':
      //       this.checkToRestConversion(node.expression, false)
      //       break
      //     default:
      //       super.checkToRestConversion(node, allowPattern)
      //   }
      // }

      // @ts-expect-error plugin overrides interfaces
      // todo we don't need this function here
      // isValidLVal(
      //   type:
      //     | "TSTypeCastExpression"
      //     | "TSParameterProperty"
      //     | "TSNonNullExpression"
      //     | "TSAsExpression"
      //     | "TSTypeAssertion",
      //   isUnparenthesizedInAssign: boolean,
      //   binding: BindingTypes,
      // ) {
      //   return (
      //     getOwn(
      //       {
      //         // Allow "typecasts" to appear on the left of assignment expressions,
      //         // because it may be in an arrow function.
      //         // e.g. `const f = (foo: number = 0) => foo;`
      //         TSTypeCastExpression: true,
      //         TSParameterProperty: "parameter",
      //         TSNonNullExpression: "expression",
      //         TSAsExpression: (binding !== BIND_NONE ||
      //           !isUnparenthesizedInAssign) && ["expression", true],
      //         TSTypeAssertion: (binding !== BIND_NONE ||
      //           !isUnparenthesizedInAssign) && ["expression", true],
      //       },
      //       type,
      //     ) || super.isValidLVal(type, isUnparenthesizedInAssign, binding)
      //   );
      // }

      parseBindingAtom(): Pattern {
        switch (this.type) {
          case tokTypes._this:
            // "this" may be the name of a parameter, so allow it.
            return this.parseIdent(/* liberal */ true)
          default:
            return super.parseBindingAtom()
        }
      }

      // todo we don't need checkCommaAfterRest and shouldParseArrow, achieve this feature in
      //  parseParenAndDistinguishExpression
      // shouldParseArrow(params: Array<N.Node>) {
      //   if (this.match(tt.colon)) {
      //     return params.every(expr => this.isAssignable(expr, true));
      //   }
      //   return super.shouldParseArrow(params);
      // }

      // checkCommaAfterRest(
      //   close: typeof charCodes[keyof typeof charCodes],
      // ): boolean {
      //   if (
      //     this.state.isAmbientContext &&
      //     this.match(tt.comma) &&
      //     this.lookaheadCharCode() === close
      //   ) {
      //     this.next();
      //     return false;
      //   } else {
      //     return super.checkCommaAfterRest(close);
      //   }
      // }

      // todo we don't support Decorator as this version
      // parseMaybeDecoratorArguments(expr: N.Expression): N.Expression {
      //   // handles `@f<<T>`
      //   if (this.match(tt.lt) || this.match(tt.bitShiftL)) {
      //     const typeArguments = this.tsParseTypeArgumentsInExpression();
      //
      //     if (this.match(tt.parenL)) {
      //       const call = super.parseMaybeDecoratorArguments(expr);
      //       call.typeParameters = typeArguments;
      //       return call;
      //     }
      //
      //     this.unexpected(null, tt.parenL);
      //   }
      //
      //   return super.parseMaybeDecoratorArguments(expr);
      // }

      parseParenAndDistinguishExpression(canBeArrow, forInit) {
        let startPos = this.start, startLoc = this.startLoc, val,
          allowTrailingComma = this.options.ecmaVersion >= 8
        if (this.options.ecmaVersion >= 6) {
          this.next()

          let innerStartPos = this.start, innerStartLoc = this.startLoc
          let exprList = [], first = true, lastIsComma = false
          let refDestructuringErrors = new DestructuringErrors,
            oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos,
            spreadStart
          this.yieldPos = 0
          this.awaitPos = 0
          // Do not save awaitIdentPos to allow checking awaits nested in parameters
          while (this.type !== tokTypes.parenR) {
            first ? first = false : this.expect(tokTypes.comma)
            if (allowTrailingComma && this.afterTrailingComma(tokTypes.parenR, true)) {
              lastIsComma = true
              break
            } else if (this.type === tokTypes.ellipsis) {
              spreadStart = this.start
              exprList.push(this.parseParenItem(this.parseRestBinding()))

              // todo checkCommaAfterRest
              const checkCommaAfterRest = (() => {
                if (
                  this.isAmbientContext &&
                  this.match(tokTypes.comma) &&
                  this.lookaheadCharCode() === charCodes.rightParenthesis
                ) {
                  this.next()
                  return false
                } else {
                  return this.match(tokTypes.comma)
                }
              })()
              if (checkCommaAfterRest) {
                this.raise(this.start, 'Comma is not permitted after the rest element')
              }
              break
            } else {
              exprList.push(this.parseMaybeAssign(false, refDestructuringErrors, this.parseParenItem))
            }
          }
          let innerEndPos = this.lastTokEnd, innerEndLoc = this.lastTokEndLoc
          this.expect(tokTypes.parenR)

          // todo typescript shouldParseArrow parseArrow
          const shouldParseArrow = ((): boolean => {
            if (this.match(tokTypes.colon)) {
              return exprList.every(expr => this.isAssignable(expr, true))
            }
            return !this.canInsertSemicolon()
          })()

          let arrowNode = this.startNodeAt<ArrowFunctionExpression>(
            startPos,
            startLoc
          )
          if (
            canBeArrow &&
            shouldParseArrow &&
            (arrowNode = this.parseArrow(arrowNode))
          ) {
            this.checkPatternErrors(refDestructuringErrors, false)
            this.checkYieldAwaitInDefaultParams()
            this.yieldPos = oldYieldPos
            this.awaitPos = oldAwaitPos
            return this.parseArrowExpression(arrowNode, exprList, false, forInit)
          }

          if (!exprList.length || lastIsComma) this.unexpected(this.lastTokStart)
          if (spreadStart) this.unexpected(spreadStart)
          this.checkExpressionErrors(refDestructuringErrors, true)
          this.yieldPos = oldYieldPos || this.yieldPos
          this.awaitPos = oldAwaitPos || this.awaitPos

          if (exprList.length > 1) {
            val = this.startNodeAt(innerStartPos, innerStartLoc)
            val.expressions = exprList
            this.finishNodeAt(val, 'SequenceExpression', innerEndPos, innerEndLoc)
          } else {
            val = exprList[0]
          }
        } else {
          val = this.parseParenExpression()
        }

        if (this.options.preserveParens) {
          let par = this.startNodeAt(startPos, startLoc)
          par.expression = val
          return this.finishNode(par, 'ParenthesizedExpression')
        } else {
          return val
        }
      }

      // todo we don't need this function, achieve this feature in
      //  parseSubscript
      // shouldParseAsyncArrow(): boolean {
      //   return this.match(tt.colon) || super.shouldParseAsyncArrow()
      // }

      parseTaggedTemplateExpression(
        base: Expression,
        startPos: number,
        startLoc: Position,
        optionalChainMember: boolean
      ): TaggedTemplateExpression {
        const node = this.startNodeAt(
          startPos,
          startLoc
        )
        node.tag = base
        node.quasi = this.parseTemplate(true)
        if (optionalChainMember) {
          this.raise(startLoc.start, 'Tagged Template Literals are not allowed'
            + ' in'
            + ' optionalChain.')
        }
        return this.finishNode(node, 'TaggedTemplateExpression')
      }

      parseSubscript(base, startPos, startLoc, noCalls, maybeAsyncArrow, optionalChained, forInit) {
        let _optionalChained = optionalChained
        // --- start extend parseSubscript
        if (
          !this.hasPrecedingLineBreak() &&
          // NODE: replace bang
          this.match(tokTypes.prefix) &&
          this.value === '!'
        ) {
          // When ! is consumed as a postfix operator (non-null assertion),
          // disallow JSX tag forming after. e.g. When parsing `p! < n.p!`
          // `<n.p` can not be a start of JSX tag
          this.canStartJSXElement = false
          this.next()

          const nonNullExpression = this.startNodeAt(
            startPos,
            startLoc
          )
          nonNullExpression.expression = base
          base = this.finishNode(nonNullExpression, 'TSNonNullExpression')
          return base
        }

        let isOptionalCall = false
        if (
          this.match(tokTypes.questionDot) &&
          this.lookaheadCharCode() === charCodes.lessThan
        ) {
          if (noCalls) {
            // NODE: we don't need to change state's stop to false.
            // state.stop = true
            return base
          }
          base.optional = true
          _optionalChained = isOptionalCall = true
          this.next()
        }

        // handles 'f<<T>'
        if (this.match(tokTypes.relational) || this.match(tokTypes.bitShift)) {
          let missingParenErrorLoc
          // tsTryParseAndCatch is expensive, so avoid if not necessary.
          // There are number of things we are going to "maybe" parse, like type arguments on
          // tagged template expressions. If any of them fail, walk it back and continue.
          const result = this.tsTryParseAndCatch(() => {
            if (!noCalls && this.atPossibleAsyncArrow(base)) {
              // Almost certainly this is a generic async function `async <T>() => ...
              // But it might be a call with a type argument `async<T>();`
              const asyncArrowFn = this.tsTryParseGenericAsyncArrowFunction(
                startPos,
                startLoc,
                forInit
              )
              if (asyncArrowFn) {
                base = asyncArrowFn
                return base
              }
            }

            const typeArguments = this.tsParseTypeArgumentsInExpression()
            if (!typeArguments) return base

            if (isOptionalCall && !this.match(tokTypes.parenL)) {
              missingParenErrorLoc = this.curPosition()
              return base
            }

            if (tokenIsTemplate(this.type)) {
              const result = this.parseTaggedTemplateExpression(
                base,
                startPos,
                startLoc,
                _optionalChained
              )
              result.typeParameters = typeArguments
              base = result
              return base
            }

            if (!noCalls && this.eat(tokTypes.parenL)) {
              let refDestructuringErrors = new DestructuringErrors
              const node = this.startNodeAt(startPos, startLoc)
              node.callee = base
              // possibleAsync always false here, because we would have handled it above.
              // @ts-expect-error (won't be any undefined arguments)
              node.arguments = this.parseExprList(
                tokTypes.parenR,
                this.options.ecmaVersion >= 8,
                false,
                refDestructuringErrors
              )

              // Handles invalid case: `f<T>(a:b)`
              this.tsCheckForInvalidTypeCasts(node.arguments)

              node.typeParameters = typeArguments
              if (_optionalChained) {
                node.optional = isOptionalCall
              }

              this.checkExpressionErrors(refDestructuringErrors, true)
              base = this.finishNode(node, 'CallExpression')
              return base
            }

            const tokenType = this.type
            if (
              // a<b>>c is not (a<b>)>c, but a<(b>>c)
              tokenType === tokTypes.relational ||
              // a<b>>>c is not (a<b>)>>c, but a<(b>>>c)
              tokenType === tokTypes.bitShift ||
              // a<b>c is (a<b)>c
              (tokenType !== tokTypes.parenL &&
                tokenCanStartExpression(tokenType) &&
                !this.hasPrecedingLineBreak())
            ) {
              // Bail out.
              return base
            }

            const node = this.startNodeAt(
              startPos,
              startLoc
            )
            node.expression = base
            node.typeParameters = typeArguments
            base = this.finishNode(node, 'TSInstantiationExpression')
            return base
          })

          if (missingParenErrorLoc) {
            this.unexpected(missingParenErrorLoc, tokTypes.parenL)
          }

          if (result) {
            if (
              result.type === 'TSInstantiationExpression' &&
              (this.match(tokTypes.dot) ||
                (this.match(tokTypes.questionDot) &&
                  this.lookaheadCharCode() !== charCodes.leftParenthesis))
            ) {
              this.raise(
                this.startLoc.start,
                TSErrors.InvalidPropertyAccessAfterInstantiationExpression
              )
            }
            base = result
            return base
          }
        }
        // --- end
        let optionalSupported = this.options.ecmaVersion >= 11
        let optional = optionalSupported && this.eat(tokTypes.questionDot)
        if (noCalls && optional) this.raise(this.lastTokStart, 'Optional chaining cannot appear in the callee of new expressions')

        let computed = this.eat(tokTypes.bracketL)
        if (computed || (optional && this.type !== tokTypes.parenL && this.type !== tokTypes.backQuote) || this.eat(tokTypes.dot)) {
          let node = this.startNodeAt(startPos, startLoc)
          node.object = base
          if (computed) {
            node.property = this.parseExpression()
            this.expect(tokTypes.bracketR)
          } else if (this.type === tokTypes.privateId && base.type !== 'Super') {
            node.property = this.parsePrivateIdent()
          } else {
            node.property = this.parseIdent(this.options.allowReserved !== 'never')
          }
          node.computed = !!computed
          if (optionalSupported) {
            node.optional = optional
          }
          base = this.finishNode(node, 'MemberExpression')
        } else if (!noCalls && this.eat(tokTypes.parenL)) {
          let refDestructuringErrors = new DestructuringErrors,
            oldYieldPos = this.yieldPos, oldAwaitPos = this.awaitPos,
            oldAwaitIdentPos = this.awaitIdentPos
          this.yieldPos = 0
          this.awaitPos = 0
          this.awaitIdentPos = 0
          let exprList = this.parseExprList(tokTypes.parenR, this.options.ecmaVersion >= 8, false, refDestructuringErrors)

          // todo typescript shouldParseAsyncArrow
          const shouldParseAsyncArrow = ((): boolean => {
            return this.match(tokTypes.colon) || (
              !this.canInsertSemicolon() && this.eat(tokTypes.arrow)
            )
          })()
          if (
            maybeAsyncArrow && !optional && shouldParseAsyncArrow
          ) {
            this.checkPatternErrors(refDestructuringErrors, false)
            this.checkYieldAwaitInDefaultParams()
            if (this.awaitIdentPos > 0)
              this.raise(this.awaitIdentPos, 'Cannot use \'await\' as identifier inside an async function')
            this.yieldPos = oldYieldPos
            this.awaitPos = oldAwaitPos
            this.awaitIdentPos = oldAwaitIdentPos
            return this.parseArrowExpression(this.startNodeAt(startPos, startLoc), exprList, true, forInit)
          }
          this.checkExpressionErrors(refDestructuringErrors, true)
          this.yieldPos = oldYieldPos || this.yieldPos
          this.awaitPos = oldAwaitPos || this.awaitPos
          this.awaitIdentPos = oldAwaitIdentPos || this.awaitIdentPos
          let node = this.startNodeAt(startPos, startLoc)
          node.callee = base
          node.arguments = exprList
          if (optionalSupported) {
            node.optional = optional
          }
          base = this.finishNode(node, 'CallExpression')
        } else if (this.type === tokTypes.backQuote) {
          // NOTE: change to _optionalChained
          if (optional || _optionalChained) {
            this.raise(this.start, 'Optional chaining cannot appear in the tag of tagged template expressions')
          }
          let node = this.startNodeAt(startPos, startLoc)
          node.tag = base
          node.quasi = this.parseTemplate({ isTagged: true })
          base = this.finishNode(node, 'TaggedTemplateExpression')
        }
        return base
      }

      // todo we don't need this function. achieve this feature in
      //  parsePropertyValue
      // canHaveLeadingDecorator() {
      //   // Avoid unnecessary lookahead in checking for abstract class unless needed!
      //   return super.canHaveLeadingDecorator() || this.isAbstractClass()
      // }

      parsePropertyValue(prop, isPattern, isGenerator, isAsync, startPos, startLoc, refDestructuringErrors, containsEsc) {
        // todo parseObjPropValue
        const typeParameters = this.tsTryParseTypeParameters()
        if (typeParameters) prop.typeParameters = typeParameters

        if ((isGenerator || isAsync) && this.type === tokTypes.colon)
          this.unexpected()

        if (this.eat(tokTypes.colon)) {
          prop.value = isPattern ? this.parseMaybeDefault(this.start, this.startLoc) : this.parseMaybeAssign(false, refDestructuringErrors)
          prop.kind = 'init'
        } else if (this.options.ecmaVersion >= 6 && this.type === tokTypes.parenL) {
          if (isPattern) this.unexpected()
          prop.kind = 'init'
          prop.method = true
          prop.value = this.parseMethod(isGenerator, isAsync)
        } else if (!isPattern && !containsEsc &&
          this.options.ecmaVersion >= 5 && !prop.computed && prop.key.type === 'Identifier' &&
          (prop.key.name === 'get' || prop.key.name === 'set') &&
          (this.type !== tokTypes.comma && this.type !== tokTypes.braceR && this.type !== tokTypes.eq)) {
          if (isGenerator || isAsync) this.unexpected()
          prop.kind = prop.key.name
          this.parsePropertyName(prop)
          prop.value = this.parseMethod(false)

          // here is getGetterSetterExpectedParamCount
          let paramCount = prop.kind === 'get' ? 0 : 1
          const firstParam = prop.value.params[0]
          const hasContextParam = firstParam && this.isThisParam(firstParam)
          paramCount = hasContextParam ? paramCount + 1 : paramCount
          // end

          if (prop.value.params.length !== paramCount) {
            let start = prop.value.start
            if (prop.kind === 'get')
              this.raiseRecoverable(start, 'getter should have no params')
            else
              this.raiseRecoverable(start, 'setter should have exactly one param')
          } else {
            if (prop.kind === 'set' && prop.value.params[0].type === 'RestElement')
              this.raiseRecoverable(prop.value.params[0].start, 'Setter cannot use rest params')
          }
        } else if (this.options.ecmaVersion >= 6 && !prop.computed && prop.key.type === 'Identifier') {
          if (isGenerator || isAsync) this.unexpected()
          this.checkUnreserved(prop.key)
          if (prop.key.name === 'await' && !this.awaitIdentPos)
            this.awaitIdentPos = startPos
          prop.kind = 'init'
          if (isPattern) {
            prop.value = this.parseMaybeDefault(startPos, startLoc, this.copyNode(prop.key))
          } else if (this.type === tokTypes.eq && refDestructuringErrors) {
            if (refDestructuringErrors.shorthandAssign < 0)
              refDestructuringErrors.shorthandAssign = this.start
            prop.value = this.parseMaybeDefault(startPos, startLoc, this.copyNode(prop.key))
          } else {
            prop.value = this.copyNode(prop.key)
          }
          prop.shorthand = true
        } else this.unexpected()
      }

      parseTryStatement(node) {
        this.next()
        node.block = this.parseBlock()
        node.handler = null
        if (this.type === tokTypes._catch) {
          let clause = this.startNode()
          this.next()
          if (this.eat(tokTypes.parenL)) {
            const param = this.parseBindingAtom()
            let simple = param.type === 'Identifier'
            this.enterScope(simple ? SCOPE_SIMPLE_CATCH : 0)
            this.checkLValPattern(param, simple ? BIND_SIMPLE_CATCH : BIND_LEXICAL)

            // start add ts support
            const type = this.tsTryParseTypeAnnotation()
            if (type) {
              param.typeAnnotation = type
              this.resetEndLocation(param)
            }
            // end

            clause.param = param
            this.expect(tokTypes.parenR)
          } else {
            if (this.options.ecmaVersion < 10) this.unexpected()
            clause.param = null
            this.enterScope(0)
          }
          clause.body = this.parseBlock(false)
          this.exitScope()
          node.handler = this.finishNode(clause, 'CatchClause')
        }
        node.finalizer = this.eat(tokTypes._finally) ? this.parseBlock() : null
        if (!node.handler && !node.finalizer)
          this.raise(node.start, 'Missing catch or finally clause')
        return this.finishNode(node, 'TryStatement')
      }

      parseClass<T extends Class>(
        node: Class,
        isStatement: boolean
      ): Class {
        const oldInAbstractClass = this.inAbstractClass
        this.inAbstractClass = !!(node as any).abstract
        try {
          this.next()

          // ---start origin parseClass
          // ecma-262 14.6 Class Definitions
          // A class definition is always strict mode code.
          const oldStrict = this.strict
          this.strict = true

          this.parseClassId(node, isStatement)
          this.parseClassSuper(node)
          const privateNameMap = this.enterClassBody()
          const classBody = this.startNode()
          let hadConstructor = false
          classBody.body = []
          this.expect(tokTypes.braceL)
          while (this.type !== tokTypes.braceR) {
            const element = this.parseClassElement(node.superClass !== null)
            if (element) {
              classBody.body.push(element)
              if (element.type === 'MethodDefinition' && element.kind === 'constructor') {
                if (hadConstructor) this.raise(element.start, 'Duplicate constructor in the same class')
                // todo typescript support duplicate constructor
                // hadConstructor = true
              } else if (element.key && element.key.type === 'PrivateIdentifier' && isPrivateNameConflicted(privateNameMap, element)) {
                this.raiseRecoverable(element.key.start, `Identifier '#${element.key.name}' has already been declared`)
              }
            }
          }
          this.strict = oldStrict
          this.next()
          node.body = this.finishNode(classBody, 'ClassBody')
          this.exitClassBody()
          return this.finishNode(node, isStatement ? 'ClassDeclaration' : 'ClassExpression')
          // ---end
        } finally {
          this.inAbstractClass = oldInAbstractClass
        }
      }

      parseMethod(
        isGenerator: boolean,
        isAsync: boolean,
        allowDirectSuper: boolean
      ) {
        let node = this.startNode(), oldYieldPos = this.yieldPos,
          oldAwaitPos = this.awaitPos, oldAwaitIdentPos = this.awaitIdentPos

        this.initFunction(node)
        if (this.options.ecmaVersion >= 6)
          node.generator = isGenerator
        if (this.options.ecmaVersion >= 8)
          node.async = !!isAsync

        this.yieldPos = 0
        this.awaitPos = 0
        this.awaitIdentPos = 0
        this.enterScope(
          functionFlags(isAsync, node.generator) |
          arcoScope.SCOPE_SUPER |
          (allowDirectSuper ? arcoScope.SCOPE_DIRECT_SUPER : 0)
        )

        this.expect(tokTypes.parenL)
        node.params = this.parseBindingList(tokTypes.parenR, false, this.options.ecmaVersion >= 8)
        this.checkYieldAwaitInDefaultParams()
        this.parseFunctionBody(node, false, true, false)
        const finishNode = this.parseFunctionBodyAndFinish(node, 'FunctionExpression', true)
        this.yieldPos = oldYieldPos
        this.awaitPos = oldAwaitPos
        this.awaitIdentPos = oldAwaitIdentPos
        const method = finishNode

        // @ts-expect-error todo(flow->ts) property not defined for all types in union
        if (method.abstract) {
          const hasBody = !!method.body
          if (hasBody) {
            const { key } = method
            this.raise(method.loc.start,
              TSErrors.AbstractMethodHasImplementation(
                key.type === 'Identifier' && !method.computed
                  ? key.name
                  : `[${this.input.slice(key.start, key.end)}]`
              )
            )
          }
        }
        return method
      }

      parse() {
        if (dts) {
          this.isAmbientContext = true
        }
        return super.parse()
      }

      parseExpressionAt() {
        if (dts) {
          this.isAmbientContext = true
        }
        return super.parseExpressionAt()
      }

      parseImportSpecifiers() {
        let nodes = [], first = true
        if (this.type === tokTypes.name) {
          // import defaultObj, { x, y as z } from '...'
          let node = this.startNode()
          node.local = this.parseIdent()
          this.checkLValSimple(node.local, BIND_LEXICAL)
          nodes.push(this.finishNode(node, 'ImportDefaultSpecifier'))
          if (!super.eat(tokTypes.comma)) return nodes
        }
        if (this.type === tokTypes.star) {
          let node = this.startNode()
          this.next()
          this.expectContextual('as')
          node.local = this.parseIdent()
          this.checkLValSimple(node.local, BIND_LEXICAL)
          nodes.push(this.finishNode(node, 'ImportNamespaceSpecifier'))
          return nodes
        }
        super.expect(tokTypes.braceL)
        while (!this.eat(tokTypes.braceR)) {
          if (!first) {
            this.expect(tokTypes.comma)
            if (this.afterTrailingComma(tokTypes.braceR)) {
              break
            }
          } else {
            first = false
          }

          let node = this.startNode()
          const isMaybeTypeOnly = this.ts_isContextual(tsTokenType.type)
          node.imported = this.parseModuleExportName()
          if (isMaybeTypeOnly) {
            this.parseTypeOnlyImportExportSpecifier(
              node,
              /* isImport */ true,
              node.importKind === 'type'
            )

            nodes.push(this.finishNode(node, 'ImportSpecifier'))
          } else {
            node.importKind = 'value'
            if (this.eatContextual('as')) {
              node.local = super.parseIdent()
            } else {
              this.checkUnreserved(node.imported)
              node.local = node.imported
            }
            this.checkLValSimple(node.local, BIND_LEXICAL)
            nodes.push(this.finishNode(node, 'ImportSpecifier'))
          }
        }
        return nodes
      }

      parseExportSpecifiers(exports, isInTypeExport = false) {
        let nodes = [], first = true
        // export { x, y as z } [from '...']
        this.expect(tokTypes.braceL)
        while (!this.eat(tokTypes.braceR)) {
          if (!first) {
            this.expect(tokTypes.comma)
            if (this.afterTrailingComma(tokTypes.braceR)) break
          } else {
            first = false
          }

          const isMaybeTypeOnly = this.ts_isContextual(tsTokenType.type)
          const isString = this.match(tokTypes.string)
          // todo support exportDefaultFrom
          // const isDefaultSpecifier = this.isExportDefaultSpecifier()
          let node = this.startNode()

          if (!isString && isMaybeTypeOnly) {
            this.parseTypeOnlyImportExportSpecifier(
              node,
              /* isImport */ false,
              isInTypeExport
            )
            this.finishNode(node, 'ExportSpecifier')
          } else {
            node.exportKind = 'value'
            if (this.eatContextual(tsTokenType.as)) {
              node.exported = this.parseModuleExportName()
            } else if (isString) {
              node.exported = this.copyNode(node.local)
            } else if (!node.exported) {
              node.exported = this.copyNode(node.local)
            }
            this.finishNode(node, 'ExportSpecifier')
          }

          this.checkExport(
            exports,
            node.exported,
            node.exported.start
          )

          nodes.push(node)
        }
        return nodes
      }

      parseTypeOnlyImportExportSpecifier(
        node: any,
        isImport: boolean,
        isInTypeOnlyImportExport: boolean
      ): void {
        const leftOfAsKey = isImport ? 'imported' : 'local'
        const rightOfAsKey = isImport ? 'local' : 'exported'

        let leftOfAs = node[leftOfAsKey]
        let rightOfAs

        let hasTypeSpecifier = false
        let canParseAsKeyword = true

        const loc = leftOfAs.loc.start

        if (this.ts_isContextual(tsTokenType.as)) {
          // { type as ...? }
          const firstAs = this.parseIdent()
          if (this.isContextual(tsTokenType.as)) {
            // { type as as ...? }
            const secondAs = this.parseIdent()
            if (tokenIsKeywordOrIdentifier(this.type)) {
              // { type as as something }
              hasTypeSpecifier = true
              leftOfAs = firstAs
              rightOfAs = isImport
                ? this.parseIdent()
                : this.parseModuleExportName()
              canParseAsKeyword = false
            } else {
              // { type as as }
              rightOfAs = secondAs
              canParseAsKeyword = false
            }
          } else if (tokenIsKeywordOrIdentifier(this.type)) {
            // { type as something }
            canParseAsKeyword = false
            rightOfAs = isImport
              ? this.parseIdent()
              : this.parseModuleExportName()
          } else {
            // { type as }
            hasTypeSpecifier = true
            leftOfAs = firstAs
          }
        } else if (tokenIsKeywordOrIdentifier(this.type)) {
          // { type something ...? }
          hasTypeSpecifier = true
          if (isImport) {
            leftOfAs = super.parseIdent(true)
            if (!this.ts_isContextual(tsTokenType.as)) {
              this.checkUnreserved(leftOfAs)
            }
          } else {
            leftOfAs = this.parseModuleExportName()
          }
        }
        if (hasTypeSpecifier && isInTypeOnlyImportExport) {
          this.raise(
            loc,
            isImport
              ? TSErrors.TypeModifierIsUsedInTypeImports
              : TSErrors.TypeModifierIsUsedInTypeExports
          )
        }

        node[leftOfAsKey] = leftOfAs
        node[rightOfAsKey] = rightOfAs

        const kindKey = isImport ? 'importKind' : 'exportKind'
        node[kindKey] = hasTypeSpecifier ? 'type' : 'value'

        if (canParseAsKeyword && this.eatContextual(tsTokenType.as)) {
          node[rightOfAsKey] = isImport
            ? this.parseIdent()
            : this.parseModuleExportName()
        }
        if (!node[rightOfAsKey]) {
          node[rightOfAsKey] = this.copyNode(node[leftOfAsKey])
        }
        if (isImport) {
          this.checkLValSimple(node[rightOfAsKey], BIND_LEXICAL)
        }
      }

    } as typeof AcornParser
  }
}

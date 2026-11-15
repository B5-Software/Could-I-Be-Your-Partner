// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
// TEST ONLY: stateful constant-product market for ordered eth_simulateV1 calls.
contract ScenarioToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address who, uint256 amount) external {balanceOf[who] += amount;}
    function deposit() external payable {balanceOf[msg.sender] += msg.value;}
    function approve(address spender, uint256 amount) external returns(bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function transfer(address to, uint256 amount) external returns(bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns(bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
contract ScenarioPool {
    address public constant token0 = 0x4200000000000000000000000000000000000006;
    address public constant token1 = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 private weth;
    uint256 private usdc;
    event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick);
    function seed() external {
        require(weth == 0);
        weth = 10 ether;
        usdc = 20_000 * 1e6;
        ScenarioToken(token0).mint(address(this), weth);
        ScenarioToken(token1).mint(address(this), usdc);
    }
    function mark() public view returns(uint160) {
        uint256 ratio = (usdc << 192) / weth;
        uint256 x = 1 << 96;
        uint256 y = (x + ratio / x) / 2;
        while (y < x) { x = y; y = (x + ratio / x) / 2; }
        return uint160(x);
    }
    function slot0() external view returns(uint160,int24,uint16,uint16,uint16,uint8,bool) {
        return (mark(),0,0,1,1,0,true);
    }
    function quote(address input, uint256 amount) public view returns(uint256) {
        return input == token0 ? (amount * usdc) / (weth + amount) : (amount * weth) / (usdc + amount);
    }
    function exchange(address input, address recipient, uint256 amount) external returns(uint256 out) {
        out = quote(input, amount);
        if (input == token0) {
            weth += amount;
            usdc -= out;
            ScenarioToken(token1).transfer(recipient, out);
            emit Swap(msg.sender, recipient, int256(amount), -int256(out), mark(), 1, 0);
        } else {
            usdc += amount;
            weth -= out;
            ScenarioToken(token0).transfer(recipient, out);
            emit Swap(msg.sender, recipient, -int256(out), int256(amount), mark(), 1, 0);
        }
    }
    function record() external {
        emit Swap(msg.sender,msg.sender,1 ether,-2000 * 1e6,mark(),1,0);
    }
}
contract ScenarioRouter {
    struct SwapParams {address tokenIn;address tokenOut;uint24 fee;address recipient;uint256 amountIn;uint256 amountOutMinimum;uint160 limit;}
    function exactInputSingle(SwapParams calldata p) external returns(uint256) {
        address pool = 0x1111111111111111111111111111111111111111;
        ScenarioToken(p.tokenIn).transferFrom(msg.sender,pool,p.amountIn);
        uint256 output = ScenarioPool(pool).exchange(p.tokenIn,p.recipient,p.amountIn);
        require(output >= p.amountOutMinimum, "minimum output");
        return output;
    }
}
contract ScenarioQuoter {
    struct Quote {address tokenIn;address tokenOut;uint256 amountIn;uint24 fee;uint160 limit;}
    function quoteExactInputSingle(Quote calldata p) external view returns(uint256,uint160,uint32,uint256) {
        ScenarioPool pool = ScenarioPool(0x1111111111111111111111111111111111111111);
        return (pool.quote(p.tokenIn,p.amountIn),pool.mark(),0,100000);
    }
}
// TEST ONLY: historical oracle responses. Anvil does not debit this fee.
contract GasOracleFixture {
    uint256 private scalar;
    uint256 private l1Fee;
    function setScalar(uint256 value) external {scalar=value;}
    function setL1Fee(uint256 value) external {l1Fee=value;}
    function getL1Fee(bytes calldata) external view returns(uint256) {return l1Fee;}
    function getOperatorFee(uint256 gasUsed) external view returns(uint256) {
        return gasUsed * (scalar == 0 ? 5 : scalar) * 100 + 7;
    }
}
// TEST ONLY: synthetic reserves and a default 2,000 USDC/WETH price. Not a DEX.
// TEST ONLY: deterministic AggregatorV3 responses, not Chainlink's implementation.
contract PriceFeedFixture {
    function decimals() external pure returns(uint8) { return 8; }
    function latestRoundData() external view returns(uint80,int256,uint256,uint256,uint80) {
        if(address(this)==0xBCF85224fc0756B9Fa45aA7892530B47e10b6433)
            return (1,0,block.timestamp-7200,block.timestamp-30,1);
        int256 answer=address(this)==0x7e860098F58bBFC8648a4311b374B1D669a2bc6B?int256(98000000):int256(200000000000);
        return (1,answer,block.timestamp-40,block.timestamp-30,1);
    }
}
contract Token {
    mapping(address=>uint256) public balanceOf;
    mapping(address=>mapping(address=>uint256)) public allowance;
    event Approval(address indexed owner,address indexed spender,uint256 value);
    event Transfer(address indexed from,address indexed to,uint256 value);
    function decimals() external view returns(uint8) {
        return address(this)==0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?6:18;
    }
    function mint(address to,uint256 value) external {balanceOf[to]+=value;}
    function approve(address spender,uint256 value) external returns(bool) {
        allowance[msg.sender][spender]=value;emit Approval(msg.sender,spender,value);return true;
    }
    function transfer(address to,uint256 value) external returns(bool) {
        require(balanceOf[msg.sender]>=value,"balance");balanceOf[msg.sender]-=value;balanceOf[to]+=value;
        emit Transfer(msg.sender,to,value);return true;
    }
    function transferFrom(address from,address to,uint256 value) external returns(bool) {
        require(allowance[from][msg.sender]>=value,"allowance");
        require(balanceOf[from]>=value,"balance");
        allowance[from][msg.sender]-=value;balanceOf[from]-=value;balanceOf[to]+=value;
        emit Transfer(from,to,value);return true;
    }
}
// TEST ONLY: AllowanceTransfer ABI fixture. recordPermit deliberately does not verify a signature.
contract Permit2Fixture {
    struct Allowance { uint160 amount; uint48 expiration; uint48 nonce; }
    struct Pair { address token; address spender; }
    mapping(address=>mapping(address=>mapping(address=>Allowance))) public allowance;
    mapping(address=>mapping(uint256=>uint256)) public nonceBitmap;
    event Approval(address indexed owner,address indexed token,address indexed spender,uint160 amount,uint48 expiration);
    event Permit(address indexed owner,address indexed token,address indexed spender,uint160 amount,uint48 expiration,uint48 nonce);
    event Lockdown(address indexed owner,address token,address spender);
    function approve(address token,address spender,uint160 amount,uint48 expiration) external {
        Allowance storage entry=allowance[msg.sender][token][spender];
        entry.amount=amount;entry.expiration=expiration;
        emit Approval(msg.sender,token,spender,amount,expiration);
    }
    function recordPermit(address token,address spender,uint160 amount,uint48 expiration,uint48 nonce) external {
        allowance[msg.sender][token][spender]=Allowance(amount,expiration,nonce+1);
        emit Permit(msg.sender,token,spender,amount,expiration,nonce);
    }
    function lockdown(Pair[] calldata pairs) external {
        for(uint256 i=0;i<pairs.length;i++) {
            Pair calldata pair=pairs[i];
            allowance[msg.sender][pair.token][pair.spender].amount=0;
            emit Lockdown(msg.sender,pair.token,pair.spender);
        }
    }
    function invalidateNonces(address token,address spender,uint48 newNonce) external {
        Allowance storage entry=allowance[msg.sender][token][spender];
        require(newNonce>entry.nonce && newNonce-entry.nonce<=type(uint16).max,"nonce");
        entry.nonce=newNonce;
    }
    function invalidateUnorderedNonces(uint256 wordPos,uint256 mask) external {
        nonceBitmap[msg.sender][wordPos]|=mask;
    }
}
contract Factory {
    function getPool(address,address,uint24) external pure returns(address) {
        return 0x1111111111111111111111111111111111111111;
    }
}
contract Pool {
    uint160 private sqrtOverride;
    function setSqrtPrice(uint160 value) external {sqrtOverride=value;}
    event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick);
    function recordSwap(int256 amount0, int256 amount1) external {
        emit Swap(msg.sender,msg.sender,amount0,amount1,3543191142285914205922034,1000000000000000000,0);
    }
    function token0() external pure returns(address) {return 0x4200000000000000000000000000000000000006;}
    function token1() external pure returns(address) {return 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;}
    function liquidity() external pure returns(uint128) {return 1000000000000000000;}
    function slot0() external view returns(uint160,int24,uint16,uint16,uint16,uint8,bool) {
        return (sqrtOverride==0?3543191142285914205922034:sqrtOverride,0,0,1,1,0,true);
    }
}
contract Quoter {
    struct Quote {address tokenIn;address tokenOut;uint256 amountIn;uint24 fee;uint160 limit;}
    function quoteExactInputSingle(Quote calldata p) external pure returns(uint256,uint160,uint32,uint256) {
        require(p.fee==500,"fee");
        uint256 result=p.tokenIn==0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?
            p.amountIn*1000000000000/2000:p.amountIn*2000/1000000000000;
        return (result,3543191142285914205922034,0,100000);
    }
}
contract Router {
    struct Swap {address tokenIn;address tokenOut;uint24 fee;address recipient;uint256 amountIn;uint256 minimum;uint160 limit;}
    uint256 public executed;
    uint256 private priceOverride;
    function multicall(uint256 deadline,bytes[] calldata calls) external payable returns(bytes[] memory results) {
        require(block.timestamp<=deadline,"deadline");require(calls.length==1,"one swap");
        results=new bytes[](calls.length);
        for(uint i=0;i<calls.length;i++){
            (bool ok,bytes memory result)=address(this).delegatecall(calls[i]);
            require(ok,"swap reverted");results[i]=result;
        }
    }
    function exactInputSingle(Swap calldata p) external payable returns(uint256 result) {
        require(p.fee==500&&p.recipient==msg.sender,"scope");
        uint256 price=priceOverride==0?2000:priceOverride;
        result=p.tokenIn==0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?
            p.amountIn*1000000000000/price:p.amountIn*price/1000000000000;
        require(result>=p.minimum,"slippage");
        Token(p.tokenIn).transferFrom(msg.sender,address(this),p.amountIn);
        Token(p.tokenOut).transfer(p.recipient,result);executed++;
        Pool pool=Pool(0x1111111111111111111111111111111111111111);
        if(p.tokenIn==0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
            pool.recordSwap(-int256(result),int256(p.amountIn));
        else pool.recordSwap(int256(p.amountIn),-int256(result));
    }
}
